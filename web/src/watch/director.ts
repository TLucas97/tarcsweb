import { bell, clamp, eio, fit, hash, type O, type Rig, type RobotState } from '../robot.tsx';
import type { AnyPattern } from '../led.tsx';
import type { Act, Station, StationKind, WatchModel } from './model.ts';

// Watch mode's choreography, ported from notes/identity/watch/v3.html: a gait plan per leg, a pure loco(T) so any
// view time poses him mid-step, the follow camera, and what his body does while he works at a station.

// Rig units per world px: the robot is drawn 150 world px tall for its 512 box.
export const RU = 512 / 150;
const DEG = Math.PI / 180;
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const frac = (x: number) => x - Math.floor(x);
const ss = (x: number) => {
  x = clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
};

export type Gait = 'stride' | 'spinwalk' | 'roll' | 'hops' | 'tumble' | 'flip';
// One stretch of a walk: gait, distance, hop count, its share of the walk's progress, and where it starts.
export type Leg = { g: Gait; d: number; nh: number; u0: number; u1: number; x0: number };
const SPEED: Record<Gait, number> = { stride: 70, spinwalk: 190, roll: 340, hops: 300, tumble: 230, flip: 330 };
// Four quarter turns of a 374-unit box about its leading corner.
const TUMBLE = (4 * 374) / RU;
const TPL: [Gait, number, number?][][] = [
  [['stride', 120], ['hops', 320, 2]],
  [['spinwalk', 480]],
  [['roll', 640]],
  [['hops', 460, 3], ['stride', 100]],
  [['hops', 282, 1], ['tumble', TUMBLE]],
  [['flip', 520]],
  [['hops', 380, 2]],
];
// A prompt is a short trip: a shuffle and two hops, or just hops.
const ASK_TPL = [0, 6];

// Each station's walk in comes from its id, so the same session always walks the same way; never the same gait twice running.
export function legsFor(id: number, prevTpl: number, kind: StationKind) {
  let tpl = kind === 'ask' ? ASK_TPL[(hash(id, 2, 5) * ASK_TPL.length) | 0] : (hash(id, 1, 3) * TPL.length) | 0;
  if (tpl === prevTpl) tpl = kind === 'ask' ? ASK_TPL.find((x) => x !== prevTpl)! : (tpl + 1) % TPL.length;
  const legs = plan(TPL[tpl]);
  return { legs, tpl, dist: legs.reduce((s, l) => s + l.d, 0) };
}

function plan(spec: [Gait, number, number?][]): Leg[] {
  const cost = spec.map(([g, d]) => d / SPEED[g]);
  const tot = cost.reduce((a, b) => a + b, 0);
  let acc = 0, x0 = 0;
  return spec.map(([g, d, nh], i) => {
    const l = { g, d, nh: nh ?? 1, u0: acc / tot, u1: (acc + cost[i]) / tot, x0 };
    acc += cost[i];
    x0 += d;
    return l;
  });
}

// A station with cards needs room before the next one: he rolls the extra floor first, then takes his usual gait.
export const widen = (legs: Leg[], extra: number) => plan([['roll', extra], ...legs.map((l) => [l.g, l.d, l.nh] as [Gait, number, number])]);

export const legDur = (legs: Leg[]) => (legs.length ? clamp(legs.reduce((s, l) => s + l.d / SPEED[l.g], 0), 1.5, 3.4) : 0);

// Smooth start, steady cruise, smooth stop: a steady cadence instead of a speed spike mid-walk.
function cruise(v: number, r = 0.22) {
  const vm = 1 / (1 - r), ramp = (s: number) => s / 2 - (r / (2 * Math.PI)) * Math.sin((Math.PI * s) / r);
  if (v < r) return vm * ramp(v);
  if (v <= 1 - r) return vm * (r / 2 + v - r);
  return 1 - vm * ramp(1 - v);
}
// Inchworm shuffle: front slab first, then the middle, then the back, so slabs never cross and planted feet stay put.
function inch(o: O, x: number, d: number, L: number, door = 0) {
  const env = ss(x / 18) * ss((d - x) / 18);
  if (env <= 0) return;
  const f = frac(x / L);
  for (let s = 0; s < 3; s++) {
    const j = 2 - s, u = clamp((f - j / 3) * 3, 0, 1), lift = u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
    o[`s${s}.x`] = (eio(u) - f - (1 / 3 - j / 3)) * L * env * RU;
    o[`s${s}.y`] = -lift * env * (s === 1 ? 12 : 18);
    o[`s${s}.r`] = 5 * lift * env;
    // The stepping slab swings edge-on like a door and faces front again as it lands.
    if (door) o[`s${s}.yaw`] = door * lift * env;
  }
  o['b.lean'] = 1.8 * env;
}
type Out = { x: number; w?: number };
const GAIT: Record<Gait, (v: number, l: Leg, o: O) => Out> = {
  stride(v, l, o) { const x = l.d * cruise(v, 0.3); inch(o, x, l.d, 30); return { x }; },
  spinwalk(v, l, o) { const x = l.d * cruise(v); inch(o, x, l.d, 56, 0.8); return { x }; },
  roll(v, l, o) {
    const x = l.d * cruise(v, 0.28), R = 187 / RU, turns = Math.max(1, Math.round(l.d / (2 * Math.PI * R)));
    o.spin = x / (l.d / (turns * 2 * Math.PI)) / DEG;
    return { x, w: fit(v, 0, 0.16, 0, 1, eio) * (1 - fit(v, 0.84, 1, 0, 1, eio)) };
  },
  hops(v, l, o) {
    const h = v * l.nh, i = Math.min(l.nh - 1, Math.floor(h)), q = h - i, dh = l.d / l.nh;
    const a = fit(q, 0.24, 0.8), air = q > 0.24 && q < 0.8 ? 4 * a * (1 - a) : 0;
    const crouch = q < 0.24 ? bell(q / 0.24) : 0, land = q > 0.8 ? bell((q - 0.8) / 0.2) : 0;
    o['b.y'] = -110 * air;
    o['b.sq'] = 6 * crouch + 7 * land - 5 * air;
    o['b.lean'] = 4 * air;
    for (let s = 0; s < 3; s++) (o[`g${s}0.y`] = 16 * crouch + 10 * land - 6 * air), (o[`g${s}2.y`] = 9 * air);
    o['s0.r'] = -4 * air;
    o['s2.r'] = 4 * air;
    return { x: (i + lerp(a, eio(a), 0.35)) * dh };
  },
  flip(v, l, o) {
    const a = fit(v, 0.2, 0.8), air = v > 0.2 && v < 0.8 ? 4 * a * (1 - a) : 0;
    const crouch = v < 0.2 ? bell(v / 0.2) : 0, land = v > 0.8 ? bell((v - 0.8) / 0.2) : 0, tuck = Math.min(1, air * 1.7);
    o['b.y'] = -230 * air;
    o['b.sq'] = 8 * crouch + 9 * land - 4 * air;
    o.spin = a >= 1 ? 0 : 360 * eio(fit(a, 0.06, 0.9));
    o['s0.x'] = 16 * tuck;
    o['s2.x'] = -16 * tuck;
    for (let s = 0; s < 3; s++) (o[`g${s}0.y`] = 20 * crouch + 12 * land + 12 * tuck), (o[`g${s}2.y`] = -12 * tuck);
    return { x: lerp(a, eio(a), 0.3) * l.d };
  },
  // Box roll: four quarter turns, each about the leading bottom corner, so nothing slides.
  tumble(v, l, o) {
    const A = 374, th = 360 * cruise(v, 0.25), i = Math.min(3, Math.floor(th / 90)), tl = (th - 90 * i) * DEG;
    const xp = (-A / 2) * Math.cos(tl) + (A / 2) * Math.sin(tl), yp = (-A / 2) * Math.sin(tl) - (A / 2) * Math.cos(tl);
    o.spin = th;
    o['b.y'] = A / 2 + yp;
    return { x: (A / 2 + i * A + xp) / RU };
  },
};

export type Loco = { x: number; o: O | null; w: number; at: number; moving: boolean; gait: Gait | null };
// Last route index whose walk has started by T, or -1: the station he is at or heading to.
export function legAt(m: WatchModel, T: number) {
  const st = m.stations;
  let lo = 0, hi = m.routeLen - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (st[mid].dep <= T) (k = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return k;
}
// Where he is and what his body does at T: pure, so any view time poses him mid-gait.
export function loco(m: WatchModel, T: number): Loco {
  const k = legAt(m, T);
  if (k < 0) return { x: m.stations[0]?.x ?? 0, o: null, w: 0, at: 0, moving: false, gait: null };
  const st = m.stations[k];
  if (T >= st.arr || !st.legs.length) return { x: st.x, o: null, w: 0, at: k, moving: false, gait: null };
  const u = (T - st.dep) / (st.arr - st.dep);
  const l = st.legs.find((x) => u <= x.u1) ?? st.legs[st.legs.length - 1];
  const o: O = {};
  const r = GAIT[l.g](clamp((u - l.u0) / (l.u1 - l.u0), 0, 1), l, o);
  return { x: st.x - st.dist + l.x0 + r.x, o, w: r.w ?? 0, at: k - 1, moving: true, gait: l.g };
}

// ---- Camera: trails him while he travels (0.3 s late) and settles on the station 0.9 s after he lands. ----
export function camTarget(m: WatchModel, T: number, vw: number) {
  const frame = (st: Station) => st.x - 0.4 * vw;
  const k = legAt(m, T);
  const st = m.stations;
  if (k <= 0) return st.length ? frame(st[0]) : 0;
  // A run of quick passing walks: start from where the camera already was, so it never jumps.
  let j = k;
  while (j > 1 && st[j - 1].arr + 0.9 > st[j].dep + 0.3) j--;
  let x = frame(st[j - 1]);
  for (let i = j; i <= k; i++) {
    const e = eio(fit(T, st[i].dep + 0.3, st[i].arr + 0.9));
    x = lerp(x, frame(st[i]), i < k ? 1 : e);
  }
  const rx = loco(m, T).x;
  return clamp(x, rx - 0.86 * vw, rx - 0.1 * vw);
}

// ---- What he does while he works: the activity sets his state; each new row pumps his panel; involuntary twitches. ----
const LED: Record<Act | 'idle', AnyPattern> = { read: 'read', search: 'search', edit: 'edit', run: 'run', think: 'think', needs: 'needs', fault: 'fault', idle: 'eyes' };
export const ledFor = (a: Act | 'idle') => LED[a];
export function stateFor(a: Act | 'idle', moving: boolean, doneAgo: number): { s: RobotState; led: AnyPattern | null } {
  if (moving) return { s: 'travel', led: LED[a] };
  if (a === 'idle') return { s: doneAgo < 4 ? 'done' : 'idle', led: null };
  if (a === 'fault') return { s: 'fault', led: null };
  return { s: a, led: null };
}

const TWITCH_EVERY = 1.35;
// Which beats and sags already glitched, so each glitches once.
export type Seen = { beats: WeakSet<object>; sag: string };
// Beat pulses and twitches into the rig's gait offsets and LED matrix.
export function processing(m: WatchModel, T: number, L: Loco, r: Rig, o: O, seen: Seen, working: boolean, landed: number[]) {
  const b = r.m.b;
  // An agent's face landing back on his panel lights it once, without the push.
  for (const t of landed) {
    const a = T - t, env = a < 0.05 ? a / 0.05 : Math.exp(-(a - 0.05) / 0.18);
    for (let k = 0; k < 9; k++) b[k] = Math.max(b[k], 1.2 * env);
  }
  // Beats live on their station in time order, so only the stations around him are scanned.
  for (const at of [L.at, L.at - 1]) {
    const beats = m.stations[at]?.beats;
    if (!beats) continue;
    for (let i = beats.length - 1; i >= 0; i--) {
      const bt = beats[i];
      const a = T - bt.tv;
      if (a > 3) break;
      if (a < 0 || a > 0.6) continue;
      // His panel fires as the thing appears, and the body pumps once, as if he pushed it out.
      const env = a < 0.05 ? a / 0.05 : Math.exp(-(a - 0.05) / 0.14);
      for (let k = 0; k < 9; k++) b[k] = Math.max(b[k], 1.25 * env * (0.55 + 0.45 * ((k % 3) / 2)));
      o['b.sq'] = (o['b.sq'] || 0) - 4 * env;
      o['b.y'] = (o['b.y'] || 0) - 5 * env;
      if (a < 0.12 && !seen.beats.has(bt)) (seen.beats.add(bt), r.burst(0.24, 0.1));
    }
  }
  if (L.moving || !working) return;
  const st = m.stations[L.at];
  if (!st || st.kind === 'start') return;
  const u = T - st.arr - 0.5;
  if (u < 0) return;
  const j = Math.floor(u / TWITCH_EVERY);
  for (const q of [j - 1, j]) {
    if (q < 0) continue;
    const tq = st.arr + 0.5 + q * TWITCH_EVERY + hash(st.id, q, 7) * 0.55, a = T - tq;
    if (a < 0 || a > 0.3) continue;
    const h = hash(st.id, q, 1), s = (hash(st.id, q, 2) * 3) | 0, k = (hash(st.id, q, 3) * 3) | 0, dir = hash(st.id, q, 5) < 0.5 ? -1 : 1;
    if (h < 0.34) {
      // Involuntary blink, sometimes twice.
      if (a < 0.08 || (hash(st.id, q, 6) < 0.3 && a > 0.16 && a < 0.22)) b.fill(0);
    } else if (h < 0.58) {
      const i = (hash(st.id, q, 4) * 9) | 0;
      if (a < 0.1) b[i] = 1.45;
      else if (a < 0.16) b[i] = 0;
    } else if (h < 0.84) o[`g${s}${k}.x`] = (o[`g${s}${k}.x`] || 0) + dir * 11 * (a < 0.05 ? 1 : 1 - fit(a, 0.12, 0.2));
    else {
      o[`s${s}.y`] = (o[`s${s}.y`] || 0) + 7 * bell(a / 0.3);
      const key = `${st.id}:${q}`;
      if (a < 0.03 && seen.sag !== key) (seen.sag = key, r.burst(0.18, 0.08));
    }
  }
}
