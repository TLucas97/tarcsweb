import { pref } from '../bits.tsx';
import { onTheme, tick } from '../led.tsx';
import { reduceMotion, subscribe as onPerf } from '../perf.ts';
import { Rig, clamp, rand, type Move, type Reach } from '../robot.tsx';
import { MOVES, roll, travel } from '../robotDirector.ts';
import { sfx, voice } from '../Sounds.ts';

// The runner egg: an endless run ported from the approved prototype, with the real rig as the runner.
// One tick() loop moves the world canvas, steps the rig and writes the score.

// ---- Tuning ----
// Jump in px/s and gravity in px/s²; holding keeps gravity at HOLD_G for the first HOLD s of the rise.
const JUMP = 720;
const GRAV = 2600;
const HOLD = 0.18;
const HOLD_G = 0.42;
// The second jump, in the air, as a share of the first.
const JUMP2 = 0.85;
// Glide: holding through the fall after the second jump caps it at GLIDE_FALL px/s under GLIDE_G; he spins GLIDE_SPIN °/s.
const GLIDE_FALL = 150;
const GLIDE_G = 1100;
const GLIDE_CATCH = 0.08;
const GLIDE_SPIN = 540;
// Speed in px/s: +ACCEL each second up to RAMP_TO, then +ACCEL2, under a far ceiling at VMAX.
const SPEED0 = 340;
const ACCEL = 9;
const RAMP_TO = 820;
const ACCEL2 = 3;
const VMAX = 1500;
// Physics and collision run in steps of at most STEP s, so a fast obstacle never slips between two frames.
const STEP = 1 / 240;
// The run cycle stops speeding up here, past where it reads as legs.
const CADENCE_MAX = 900;

type Kind = 'single' | 'badge' | 'pair' | 'tall' | 'rhythm' | 'wall' | 'stairs' | 'down' | 'tower';
// Each pattern unlocks at a score, then is picked by weight.
const PATTERNS: Record<Kind, { from: number; weight: number }> = {
  single: { from: 0, weight: 3 },
  badge: { from: 0, weight: 1 },
  pair: { from: 150, weight: 2 },
  tall: { from: 150, weight: 2 },
  rhythm: { from: 300, weight: 2 },
  wall: { from: 300, weight: 1.5 },
  stairs: { from: 500, weight: 1.5 },
  down: { from: 500, weight: 1 },
  tower: { from: 500, weight: 1.5 },
};
// From MIX_FROM, this share of patterns follows the previous one with only the fair gap, no rest.
const MIX_FROM = 800;
const MIX_ODDS = 0.45;
// Card pitch of a stack, and the taller blocks of tall stacks (5 need a held jump) and towers (6-7 need the double jump).
const CARD = 16;
const BLOCK = 28;
const TALL = [4, 5];
const TOWER = [6, 7];
const WALL_CARDS = [2, 3];
const WALL_MIN = 90;
const PAIR_GAP = 24;
const RHYTHM = [3, 4];
// Stairs climb or drop over 4 steps, 5 from STAIR5_FROM; each step is split into stacks about STAIR_STACK px wide.
const STAIR5_FROM = 650;
const STAIR_STACK = 40;
// Single stacks may come wide past FAST px/s.
const FAST = 480;
// Fairness: each pattern must clear with its intended flight at speed / MARGIN. The model taps for TAP_HOLD s, presses
// the second jump PRESS2 s after take-off (the apex is at 0.38 s) and needs LAND_T s on the ground between two jumps.
const MARGIN = 1.15;
const TAP_HOLD = 0.1;
const PRESS2 = 0.25;
const LAND_T = 0.12;
// A pattern is built up to AHEAD s before he meets it; its gaps assume the speed he may have by then.
const AHEAD = 8;
// Rest between patterns, end to next start: speed × REST_LO..REST_HI + REST_PX, shrinking to REST_MIN of it by REST_SCORE.
const REST_LO = 0.75;
const REST_HI = 1.5;
const REST_PX = 114;
const REST_MIN = 0.5;
const REST_SCORE = 1000;
const FIRST_GAP = 420;
// The hint shows for HINT_RUN s at each start, and HINT_STAIRS s when the first stairs of a run come.
const HINT_RUN = 6;
const HINT_STAIRS = 3.5;

// Seconds after a crash before Space or a click restarts.
const AGAIN = 0.45;
// px run per point, and a blip every MILE points.
const PER_POINT = 40;
const MILE = 100;
// His rig box in px: the slabs fill 385 of its 512 units, so he stands about 48 px tall.
const PX = 64;
const U = PX / 512;
const REACH: Reach = { l: 96, t: 96, w: 704, h: 704 };
// His centre from the left and the ground line from the bottom, in px.
const X = 110;
const FLOOR = 64;
// The speech bubble: odds per jump, the least gap between two, and how long one shows.
const WORDS = ['hup!', 'beep.', 'boing', 'wheee', '01!', 'jump.exe', 'nope', 'bzzt!', 'yeet.bin', 'hop()'];
const SAY_ODDS = 0.45;
const SAY_GAP = 1.2;
const SAY_FOR = 0.85;
const BEST_KEY = 'runner.best';

type Badge = 'js' | 'ts' | 'go' | 'braces' | 'tag' | 'semi';
// A ground obstacle; stacks have n cards of pitch ch.
type Ob = { k: 'bug' | 'stack' | Badge; x: number; w: number; h: number; n: number; ch: number };
// Developer badges, all of a jumpable size: [w, h] in px.
const BADGES: Record<Badge, [number, number]> = { js: [28, 28], ts: [28, 28], go: [40, 22], braces: [36, 30], tag: [42, 26], semi: [16, 40] };
const BADGE_KINDS = Object.keys(BADGES) as Badge[];
type Colors = Record<'bg' | 'ink' | 'muted' | 'faint' | 'line' | 'soft' | 'track' | 'coral' | 'red', string>;
export type Over = { score: number; best: number; rec: boolean };
export const pad = (n: number) => String(Math.floor(n)).padStart(5, '0');
const pick = <T>(a: readonly T[]) => a[(Math.random() * a.length) | 0];
const accel = (v: number) => (v < RAMP_TO ? ACCEL : ACCEL2);

// Vertical speed after one step: lighter gravity while a held jump rises, a capped fall while gliding.
function gravity(vy: number, held: boolean, hold: number, glide: boolean, dt: number) {
  if (glide) return vy < -GLIDE_FALL ? vy + (-GLIDE_FALL - vy) * (1 - Math.exp(-dt / GLIDE_CATCH)) : Math.max(-GLIDE_FALL, vy - GLIDE_G * dt);
  return vy - (held && hold > 0 && vy > 0 ? GRAV * HOLD_G : GRAV) * dt;
}

// ---- Fairness: flights simulated with the game's own steps, and the take-off window they leave over a pattern ----
const MAX_H = 512;
// Air time, and when he first reaches and last leaves each whole height; every flight rises then falls.
type Flight = { T: number; tin: Float32Array; tout: Float32Array };
function fly(release: number, press2: number, keep: boolean): Flight {
  const ys: number[] = [];
  let y = 0, vy = JUMP, hold = HOLD, held = true, used2 = false, t = 0;
  do {
    if (!used2 && t >= release) held = false;
    if (!used2 && t >= press2) (used2 = true), (vy = JUMP * JUMP2), (hold = HOLD), (held = true);
    if (used2 && !keep && vy <= 0) held = false;
    hold -= STEP;
    vy = gravity(vy, held, hold, used2 && held && vy <= 0, STEP);
    y += vy * STEP;
    t += STEP;
    ys.push(Math.max(0, y));
  } while (y > 0 && t < 20);
  const tin = new Float32Array(MAX_H + 1).fill(Infinity), tout = new Float32Array(MAX_H + 1).fill(-Infinity);
  let top = -1;
  for (let i = 0; i < ys.length; i++) for (const f = Math.min(MAX_H, Math.floor(ys[i])); top < f; ) tin[++top] = (i + 1) * STEP;
  top = -1;
  for (let i = ys.length - 1; i >= 0; i--) for (const f = Math.min(MAX_H, Math.floor(ys[i])); top < f; ) tout[++top] = (i + 1) * STEP;
  return { T: ys.length * STEP, tin, tout };
}
const TAP = fly(TAP_HOLD, Infinity, false);
const HELD = fly(Infinity, Infinity, false);
const DOUBLE = fly(Infinity, PRESS2, false);
const GLIDE = fly(Infinity, PRESS2, true);

// Where his centre can take off (pattern px, first obstacle at 0) and clear every obstacle at speed v, or null.
// He hits an obstacle while his centre is within 10 px of it and he is below its top less 5 (see update()).
function takeoff(obs: Ob[], f: Flight, v: number): [number, number] | null {
  let lo = -Infinity, hi = Infinity;
  for (const o of obs) {
    const need = Math.min(MAX_H, Math.max(0, Math.ceil(o.h - 5)));
    lo = Math.max(lo, o.x + o.w + 10 - v * f.tout[need]);
    hi = Math.min(hi, o.x - 10 - v * f.tin[need]);
  }
  return lo <= hi ? [lo, hi] : null;
}
// The largest size in [lo, hi] whose obstacles still clear, or 0; a bigger size is never easier.
function fit(build: (s: number) => Ob[], f: Flight, v: number, lo: number, hi: number) {
  if (!takeoff(build(lo), f, v)) return 0;
  for (let i = 0; i < 14; i++) {
    const m = (lo + hi) / 2;
    if (takeoff(build(m), f, v)) lo = m;
    else hi = m;
  }
  return lo;
}
// Ground he needs before a group (taking off at the latest moment) and how far past its end he may land.
function measure(obs: Ob[], f: Flight, v: number) {
  const w = takeoff(obs, f, v);
  if (!w) return null;
  const end = Math.max(...obs.map((o) => o.x + o.w));
  return { lead: -w[1], tail: w[1] + v * f.T - end, end };
}

// A pattern: groups each cleared in one flight, laid out with fair landing room between them.
type Seg = { obs: Ob[]; f: Flight };
type Plan = { kind: Kind; obs: Ob[]; len: number; lead: number; tail: number };
function lay(kind: Kind, segs: Seg[], v: number): Plan | null {
  const vf = Math.min(VMAX, v + accel(v) * AHEAD), obs: Ob[] = [];
  let x = 0, lead = 0, tail = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], m = takeoff(s.obs, s.f, v / MARGIN) && measure(s.obs, s.f, vf);
    if (!m) return null;
    if (i) x += (tail + vf * LAND_T + m.lead) * MARGIN;
    else lead = m.lead;
    for (const o of s.obs) obs.push({ ...o, x: o.x + x });
    x += m.end;
    tail = m.tail;
  }
  // He may hold a jump meant as a tap, so the room after the pattern allows a held one.
  tail = Math.max(tail, measure(segs[segs.length - 1].obs, HELD, vf)?.tail ?? 0);
  return { kind, obs, len: x, lead, tail };
}

const stack = (x: number, n: number, w: number, ch = CARD): Ob => ({ k: 'stack', x, w, h: n * ch, n, ch });
const bug = (): Ob => ({ k: 'bug', x: 0, w: 30, h: 20, n: 1, ch: 0 });
const small = () => (Math.random() < 0.45 ? bug() : stack(0, Math.random() < 0.35 ? 2 : 1, 36));
function single(v: number) {
  if (Math.random() < 0.4) return bug();
  const big = v > FAST;
  return stack(0, 1 + Math.floor(Math.random() * (big ? 3 : 2)), big && Math.random() < 0.35 ? 60 : 36);
}
function badge(): Ob {
  const k = pick(BADGE_KINDS), [w, h] = BADGES[k];
  return { k, x: 0, w, h, n: 1, ch: 0 };
}
// Packed steps of 1..steps cards over L px, so he cannot land on the way.
function stairs(L: number, steps: number, down: boolean, split: boolean) {
  const out: Ob[] = [], sw = L / steps;
  for (let i = 0; i < steps; i++) {
    const n = down ? steps - i : i + 1, m = split ? Math.max(1, Math.round(sw / STAIR_STACK)) : 1;
    for (let j = 0; j < m; j++) out.push(stack(i * sw + (j * sw) / m, n, sw / m));
  }
  return out;
}

function choose(score: number): Kind {
  const open = (Object.keys(PATTERNS) as Kind[]).filter((k) => score >= PATTERNS[k].from);
  let x = Math.random() * open.reduce((a, k) => a + PATTERNS[k].weight, 0);
  for (const k of open) if ((x -= PATTERNS[k].weight) <= 0) return k;
  return 'single';
}

// Sizes come from the flights: each pattern fits its intended move at this speed with MARGIN to spare.
function build(kind: Kind, v: number, score: number): Plan | null {
  const vm = v / MARGIN;
  switch (kind) {
    case 'single':
      return lay(kind, [{ obs: [single(v)], f: HELD }], v);
    case 'badge':
      return lay(kind, [{ obs: [badge()], f: HELD }], v);
    case 'pair': {
      // Two small ones close enough to take in one held jump.
      const a = small(), b = small(), most = fit((g) => [a, { ...b, x: a.w + g }], HELD, vm, PAIR_GAP, 2000);
      return most ? lay(kind, [{ obs: [a, { ...b, x: a.w + Math.max(PAIR_GAP, most * rand(0.45, 0.85)) }], f: HELD }], v) : null;
    }
    case 'tall':
      return lay(kind, [{ obs: [stack(0, pick(TALL), 40, BLOCK)], f: HELD }], v);
    case 'rhythm':
      // Jump, land, jump: each gap is the least fair one.
      return lay(kind, Array.from({ length: pick(RHYTHM) }, () => ({ obs: [small()], f: TAP })), v);
    case 'wall': {
      const n = pick(WALL_CARDS), most = fit((w) => [stack(0, n, w)], HELD, vm, 40, 1500);
      return most >= WALL_MIN ? lay(kind, [{ obs: [stack(0, n, Math.max(WALL_MIN, most * rand(0.55, 0.9)))], f: HELD }], v) : null;
    }
    case 'tower':
      return lay(kind, [{ obs: [stack(0, pick(TOWER), 40, BLOCK)], f: DOUBLE }], v);
    case 'stairs':
    case 'down': {
      // Longer than a double jump can clear, so only the glide gets over; never longer than the glide allows.
      const steps = score >= STAIR5_FROM && Math.random() < 0.5 ? 5 : 4, make = (L: number) => stairs(L, steps, kind === 'down', false);
      const most = fit(make, GLIDE, vm, steps * 30, 8000);
      if (!most) return null;
      const L = Math.max(Math.min(most, fit(make, DOUBLE, v, steps * 30, 8000) * 1.08), most * rand(0.85, 1));
      return lay(kind, [{ obs: stairs(L, steps, kind === 'down', true), f: GLIDE }], v);
    }
  }
}

// Double-jump tricks from the shared catalogue, squeezed into his air time; the physics keeps the height.
function trick(dur: number): Move {
  if (Math.random() < 0.5) return { name: 'Air roll', dur, light: 'ring', lightDur: dur, enter: (r) => void (r.move!.trip = roll(0, 2 * Math.PI * 187, dur)), seq: travel };
  return {
    name: 'Air flip', dur, light: 'ring', lightDur: dur,
    seq(r, s, o) {
      MOVES.flip.seq!(r, 0.42 + (0.7 * s) / dur, o);
      delete o['b.y'];
    },
  };
}

export class Game {
  onOver: (o: Over) => void = () => {};
  onStart: () => void = () => {};
  private root: HTMLElement;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private host: HTMLElement;
  private sc: HTMLElement;
  private hi: HTMLElement;
  private hint: HTMLElement;
  private rig: Rig | null = null;
  private still = reduceMotion();
  private C = {} as Colors;
  private font = '';
  private mono = '';
  private W = 0;
  private H = 0;
  private dpr = 1;
  private stop: (() => void) | null = null;
  private offs: (() => void)[] = [];
  private dirty = true;
  private tf = '';
  private shown = { sc: '', hi: '', op: '', hint: false };
  // The run, and the next pattern: built one ahead so the gap before it can be fair. lastX is where the last one starts.
  private mode: 'play' | 'over' = 'play';
  private t = 0;
  private obs: Ob[] = [];
  private next: Plan | null = null;
  private lastX = NaN;
  private nextGap = FIRST_GAP;
  private speed = SPEED0;
  private score = 0;
  private best = 0;
  private mile = MILE;
  private scroll = 0;
  private flash = 0;
  private crashAt = 0;
  private stairsSeen = false;
  private hintUntil = 0;
  // Him: height above the ground and its speed, the hold, the second jump, the glide, the run cycle and the air pose.
  private y = 0;
  private vy = 0;
  private hold = 0;
  private held = false;
  private used2 = false;
  private gliding = false;
  private spinning = false;
  private spinA = 0;
  private phase = 0;
  private airK = 0;
  private lifted = [false, false, false];
  private say: { i: number; t: number; w: number } | null = null;
  private sayAt = -9;

  constructor(root: HTMLElement) {
    const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    this.root = root;
    this.cv = q<HTMLCanvasElement>('canvas.rn-world');
    this.g = this.cv.getContext('2d')!;
    this.host = q('.rn-bot');
    this.sc = q('.rn-now');
    this.hi = q('.rn-hi');
    this.hint = q('.rn-hint');
    const b = pref.get<unknown>(BEST_KEY, 0);
    this.best = typeof b === 'number' && Number.isFinite(b) ? Math.max(0, Math.floor(b)) : 0;
    this.theme();
    this.buildRig();
    const ro = new ResizeObserver((es) => {
      const r = es[es.length - 1].contentRect;
      this.layout(r.width, r.height);
    });
    ro.observe(root);
    this.offs.push(() => ro.disconnect());
    this.offs.push(onTheme(() => (this.theme(), (this.dirty = true))));
    // perf.ts also fires on a profile change; only a reduced-motion flip rebuilds him.
    this.offs.push(onPerf(() => {
      if (reduceMotion() === this.still) return;
      this.still = reduceMotion();
      this.spinning = false;
      this.buildRig();
      this.dirty = true;
    }));
    const on = (el: EventTarget, type: string, fn: (e: never) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on(root, 'pointerdown', this.down);
    on(window, 'pointerup', this.release);
    on(window, 'pointercancel', this.release);
    on(window, 'blur', this.release);
    on(document, 'keydown', this.key);
    on(document, 'keyup', this.keyUp);
    this.start();
    this.stop = tick(this.frame);
  }

  dispose() {
    this.stop?.();
    this.stop = null;
    for (const f of this.offs) f();
    this.rig?.destroy();
    this.rig = null;
    this.host.replaceChildren();
  }

  start = () => {
    this.mode = 'play';
    this.obs = [];
    this.speed = SPEED0;
    this.score = this.flash = 0;
    this.lastX = NaN;
    this.nextGap = FIRST_GAP;
    this.next = this.plan();
    this.mile = MILE;
    this.y = this.vy = this.hold = 0;
    this.held = this.used2 = this.gliding = this.stairsSeen = false;
    this.say = null;
    this.hintUntil = this.t + HINT_RUN;
    this.rig?.set('idle', null, { quiet: true });
    this.dirty = true;
    this.onStart();
  };

  // Canvases cannot read CSS variables: the colours are read here, again on each theme change.
  private theme() {
    const cs = getComputedStyle(this.root);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    this.C = {
      bg: v('--bg', '#faf9f5'), ink: v('--ink', '#2b2a27'), muted: v('--muted', '#747168'), faint: v('--faint', '#a9a59a'), line: v('--line', '#e8e4d9'),
      soft: v('--soft', '#f1efe8'), track: v('--track', '#e9e5da'), coral: v('--coral', '#b7841f'), red: v('--red', '#9f2f2d'),
    };
    this.font = v('--sans', 'system-ui,sans-serif');
    this.mono = getComputedStyle(this.sc).fontFamily || 'monospace';
  }

  private layout(w: number, h: number) {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.W = w;
    this.H = h;
    this.cv.width = Math.round(w * this.dpr);
    this.cv.height = Math.round(h * this.dpr);
    this.tf = '';
    this.dirty = true;
  }

  // Driven like watch mode: this loop steps him and moves his canvas by transform.
  private buildRig() {
    this.rig?.destroy();
    const r = new Rig(this.host, { level: 'full', px: PX, tile: false, still: this.still, reach: REACH, cue: () => {}, driven: true });
    r.cv!.style.cssText = `position:absolute;left:0;top:0;width:${REACH.w * U}px;height:${REACH.h * U}px;will-change:transform;pointer-events:none`;
    r.set(this.mode === 'over' ? 'error' : 'idle', null, { quiet: true, force: true });
    r.render();
    this.rig = r;
    this.tf = '';
  }

  // ---- Input ----
  private key = (e: KeyboardEvent) => {
    if ((e.code !== 'Space' && e.code !== 'ArrowUp') || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (!e.repeat) this.press();
  };
  private keyUp = (e: KeyboardEvent) => (e.code === 'Space' || e.code === 'ArrowUp') && this.release();
  private down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    e.preventDefault();
    this.press();
  };
  private release = () => void (this.held = false);

  // Ground: jump. Air: the second jump, or after it a new hold that glides again.
  private press() {
    if (this.mode === 'over') {
      if (this.t - this.crashAt > AGAIN) this.start();
      return;
    }
    if (this.y <= 0.01 && this.vy <= 0) this.jump(JUMP, false);
    else if (!this.used2) this.jump(JUMP * JUMP2, true);
    else this.held = true;
  }

  private jump(v: number, second: boolean) {
    const r = this.rig!;
    this.vy = v;
    this.hold = HOLD;
    this.held = true;
    if (second) {
      this.used2 = true;
      sfx('jump2');
      const air = (v + Math.sqrt(v * v + 2 * GRAV * this.y)) / GRAV;
      if (!this.still) r.play('trick', trick(clamp(air * 0.9, 0.35, 0.8)), 'runner');
    } else {
      sfx('jump');
      if (!this.still) r.imp('b.sq', -60);
    }
    if (this.t - this.sayAt <= SAY_GAP || Math.random() >= SAY_ODDS) return;
    const i = (Math.random() * WORDS.length) | 0;
    this.g.font = `500 16px ${this.font}`;
    this.say = { i, t: this.t, w: this.g.measureText(WORDS[i]).width + 22 };
    this.sayAt = this.t;
    voice(i + 1);
  }

  private land() {
    const r = this.rig!, hard = this.vy < -250;
    this.y = this.vy = 0;
    this.used2 = this.gliding = false;
    if (this.still) return;
    // A trick still playing hands its offsets to the springs, which carry him upright.
    if (r.move) r.stopMove();
    if (hard) r.land(200);
  }

  private crash() {
    this.mode = 'over';
    this.crashAt = this.t;
    this.held = this.gliding = false;
    sfx('crash');
    const s = Math.floor(this.score), rec = s > this.best;
    if (rec) {
      this.best = s;
      pref.set(BEST_KEY, s);
    }
    this.rig!.set('error');
    this.dirty = true;
    this.onOver({ score: s, best: this.best, rec });
  }

  private plan() {
    return build(choose(this.score), this.speed, this.score) ?? build('single', this.speed, this.score)!;
  }

  // Places the waiting pattern and builds the one after it; the gap between them is fair first, then rest on top.
  private spawn(x0: number) {
    const p = this.next!, n = this.plan(), v = this.speed, vf = Math.min(VMAX, v + accel(v) * AHEAD);
    for (const o of p.obs) this.obs.push({ ...o, x: o.x + x0 });
    if ((p.kind === 'stairs' || p.kind === 'down') && !this.stairsSeen) (this.stairsSeen = true), (this.hintUntil = this.t + HINT_STAIRS);
    const fair = (p.tail + vf * LAND_T + n.lead) * MARGIN;
    const shrink = 1 - (1 - REST_MIN) * Math.min(1, this.score / REST_SCORE);
    const rest = this.score >= MIX_FROM && Math.random() < MIX_ODDS ? 0 : (v * rand(REST_LO, REST_HI) + REST_PX) * shrink;
    this.lastX = x0;
    this.nextGap = p.len + Math.max(fair, rest);
    this.next = n;
  }

  // ---- Loop ----
  private frame = (raw: number) => {
    if (!this.W || !this.rig) return;
    const dt = Math.min(0.05, raw);
    this.t += dt;
    if (this.mode === 'play') {
      const n = Math.ceil(dt / STEP);
      for (let i = 0; i < n && this.mode === 'play'; i++) this.update(dt / n);
      this.phase += (dt * Math.min(this.speed, CADENCE_MAX)) / 30;
    }
    // A crash in the air: he drops to the ground.
    else if (this.y > 0) (this.vy -= GRAV * dt), (this.y = Math.max(0, this.y + this.vy * dt));
    this.pose(dt);
    this.place();
    if (this.mode === 'play' || this.dirty || this.say) this.draw();
    this.hud(dt);
  };

  private update(dt: number) {
    this.speed = Math.min(VMAX, this.speed + accel(this.speed) * dt);
    const dx = this.speed * dt;
    this.scroll += dx;
    this.score += dx / PER_POINT;
    if (this.score >= this.mile) {
      this.mile += MILE;
      this.flash = 0.7;
      sfx('blip');
    }
    this.hold -= dt;
    if (this.y > 0 || this.vy > 0) {
      this.gliding = this.used2 && this.held && this.vy <= 0;
      this.vy = gravity(this.vy, this.held, this.hold, this.gliding, dt);
      this.y += this.vy * dt;
      if (this.y <= 0) this.land();
    }
    for (const o of this.obs) o.x -= dx;
    if (this.obs.length && this.obs[0].x + this.obs[0].w < -30) this.obs.shift();
    if (Number.isNaN(this.lastX)) this.lastX = this.W + 20;
    this.lastX -= dx;
    if (this.lastX + this.nextGap <= this.W + 20) this.spawn(this.lastX + this.nextGap);
    // Obstacles are in x order, so the scan stops at the first one still ahead of him.
    const gy = this.H - FLOOR, l = X - 15, r = X + 15, b = gy - this.y;
    for (const o of this.obs) {
      if (o.x + 5 >= r) break;
      if (l < o.x + o.w - 5 && b > gy - o.h + 5) return this.crash();
    }
  }

  // The prototype's run cycle as gait offsets: each slab lifts in turn while he leans in; in the air the outer slabs trail.
  // A glide folds him into the wheel and spins it until he lands or lets go.
  private pose(dt: number) {
    const r = this.rig!;
    if (this.still) return;
    const o = r.goff;
    for (const k in o) delete o[k];
    const glide = this.mode === 'play' && this.gliding;
    if (glide !== this.spinning) {
      this.spinning = glide;
      // The double jump's trick hands over to the spin; at the end the visible angle goes to the spring, which turns him upright.
      if (!glide) r.settleSpin({ spin: this.spinA });
      else if (r.move) r.stopMove();
      this.spinA = 0;
      r.tgt('w', glide ? 1 : 0);
    }
    if (glide) {
      this.spinA += GLIDE_SPIN * dt;
      o.spin = this.spinA;
    } else if (this.mode === 'play' && !r.move) {
      const air = this.y > 0 ? 1 : 0, lag = clamp(this.vy * 0.08, -70, 70);
      this.airK += (air - this.airK) * (1 - Math.exp(-dt / 0.05));
      const a = this.airK;
      for (let s = 0; s < 3; s++) {
        const lift = Math.max(0, Math.sin(this.phase + s * 2.1));
        // A foot coming down lights its bottom dot.
        if (!air && this.lifted[s] && !lift) r.fx.hit(6 + s, 0.8);
        this.lifted[s] = lift > 0;
        o[`s${s}.y`] = -44 * lift * (1 - a) + (s === 1 ? 0 : lag * a);
        o[`s${s}.r`] = 5 * lift * (1 - a);
      }
      o['s0.x'] = -26 * a;
      o['s2.x'] = 26 * a;
      o['b.lean'] = 3 * (1 - a);
    }
    r.step(dt);
  }

  private place() {
    const by = this.H - FLOOR - this.y;
    const tf = `translate3d(${(X - (REACH.l + 256) * U).toFixed(1)}px,${(by - (REACH.t + 443) * U).toFixed(1)}px,0)`;
    if (tf !== this.tf) (this.rig!.cv!.style.transform = tf), (this.tf = tf);
  }

  private hud(dt: number) {
    if (this.flash > 0) this.flash -= dt;
    const sc = pad(this.score), hi = `HI ${pad(this.best)}`, hint = this.t < this.hintUntil;
    if (sc !== this.shown.sc) this.sc.textContent = this.shown.sc = sc;
    if (hi !== this.shown.hi) this.hi.textContent = this.shown.hi = hi;
    if (hint !== this.shown.hint) this.hint.toggleAttribute('data-on', (this.shown.hint = hint));
    // The score blinks at each hundred; reduced motion drops it.
    const op = !this.still && this.flash > 0 && Math.floor(this.flash * 10) % 2 ? '0.3' : '';
    if (op !== this.shown.op) this.sc.style.opacity = this.shown.op = op;
  }

  // ---- Drawing ----
  private draw() {
    this.dirty = false;
    const g = this.g, C = this.C, W = this.W, H = this.H, gy = H - FLOOR;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    // A faint grid drifting behind, a decorative extra that reduced motion drops.
    if (!this.still) {
      const gs = 32, off = (this.scroll * 0.15) % gs;
      g.globalAlpha = 0.05;
      g.strokeStyle = C.ink;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = -off; x < W; x += gs) g.moveTo(Math.round(x) + 0.5, 0), g.lineTo(Math.round(x) + 0.5, H);
      for (let y = 0; y < H; y += gs) g.moveTo(0, y + 0.5), g.lineTo(W, y + 0.5);
      g.stroke();
      g.globalAlpha = 1;
    }
    g.globalAlpha = 0.6;
    g.strokeStyle = C.faint;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, gy + 1);
    g.lineTo(W, gy + 1);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = C.track;
    const span = W + 40;
    for (let i = 0, n = Math.ceil(W / 28); i < n; i++) {
      const p = ((((i * 97.3 - this.scroll) % span) + span) % span) - 20;
      g.fillRect(p, gy + 9 + ((i * 13) % 3) * 8, (i % 4) + 2, 2);
    }
    for (const o of this.obs) {
      if (o.x > W) break;
      this.ob(o, gy);
    }
    this.bubble(gy);
  }

  private bubble(gy: number) {
    const b = this.say;
    if (!b) return;
    const age = this.t - b.t;
    if (age > SAY_FOR) return void (this.say = null);
    const g = this.g, C = this.C, x = X + 16, y = gy - this.y - 54;
    g.globalAlpha = age < 0.1 ? age / 0.1 : age > 0.6 ? (SAY_FOR - age) / 0.25 : 1;
    g.beginPath();
    g.roundRect(x, y - 30, b.w, 30, 10);
    g.fillStyle = C.soft;
    g.fill();
    g.strokeStyle = C.line;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = C.ink;
    g.font = `500 16px ${this.font}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(WORDS[b.i], x + 11, y - 14.5);
    g.globalAlpha = 1;
  }

  private ob(o: Ob, gy: number) {
    const g = this.g, C = this.C, x = o.x, top = gy - o.h;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    switch (o.k) {
      case 'bug': {
        const w = Math.sin(this.t * 22 + x * 0.1) * 2.5;
        g.globalAlpha = 0.7;
        g.strokeStyle = C.red;
        g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i < 3; i++) {
          const lx = x + 10 + i * 7;
          g.moveTo(lx, gy - 8);
          g.lineTo(lx - 3 + (i % 2 ? w : -w), gy);
        }
        g.moveTo(x + 3, gy - 17);
        g.lineTo(x - 2, gy - 24);
        g.moveTo(x + 6, gy - 18);
        g.lineTo(x + 6, gy - 26);
        g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = C.red;
        g.beginPath();
        g.ellipse(x + 18, gy - 11, 13, 9, 0, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 0.8;
        g.beginPath();
        g.arc(x + 5, gy - 12, 6, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 0.55;
        g.strokeStyle = C.bg;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x + 18, gy - 20);
        g.lineTo(x + 18, gy - 2);
        g.stroke();
        g.globalAlpha = 1;
        return;
      }
      case 'stack': {
        // Error cards: an X and two text lines, scaled to the card's height (blocks are taller cards).
        const ih = o.ch - 2, m = Math.round(ih * 0.43), l1 = Math.round(ih * 0.3), l2 = Math.round(ih * 0.57), w = o.w - 3, lw = w - 16 - m;
        for (let k = 0; k < o.n; k++) {
          const cx = x + (k % 2 ? 3 : 0), cy = gy - (k + 1) * o.ch;
          g.beginPath();
          g.roundRect(cx, cy, w, ih, 4);
          g.fillStyle = C.soft;
          g.fill();
          g.strokeStyle = C.red;
          g.lineWidth = 1.5;
          g.stroke();
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(cx + 5, cy + 4);
          g.lineTo(cx + 5 + m, cy + 4 + m);
          g.moveTo(cx + 5 + m, cy + 4);
          g.lineTo(cx + 5, cy + 4 + m);
          g.stroke();
          if (lw < 3) continue;
          g.fillStyle = C.faint;
          g.fillRect(cx + 10 + m, cy + l1, lw, 2);
          g.fillRect(cx + 10 + m, cy + l2, lw * 0.6, 2);
        }
        return;
      }
      case 'js':
      case 'ts':
      case 'go': {
        // Brand colours on purpose: they read the same on both themes.
        const [fill, ink, r]: [string, string, number] = o.k === 'js' ? ['#f7df1e', '#1e1d1a', 3] : o.k === 'ts' ? ['#3178c6', '#ffffff', 3] : ['#00add8', '#ffffff', o.h / 2];
        g.beginPath();
        g.roundRect(x, top, o.w, o.h, r);
        g.fillStyle = fill;
        g.fill();
        g.strokeStyle = 'rgb(0 0 0 / .14)';
        g.lineWidth = 1;
        g.stroke();
        g.fillStyle = ink;
        g.font = `${o.k === 'go' ? 'italic ' : ''}700 13px ${this.mono}`;
        g.textBaseline = 'alphabetic';
        g.textAlign = o.k === 'go' ? 'center' : 'right';
        g.fillText(o.k.toUpperCase(), o.k === 'go' ? x + o.w / 2 : x + o.w - 3, o.k === 'go' ? gy - 6 : gy - 4);
        g.textAlign = 'left';
        return;
      }
    }
    g.strokeStyle = g.fillStyle = C.ink;
    g.lineWidth = 3.5;
    g.beginPath();
    if (o.k === 'braces') {
      // { }: each brace bends to a point at mid height.
      const m = gy - o.h / 2;
      for (const [x0, d] of [[x + 10, 1], [x + o.w - 10, -1]]) {
        g.moveTo(x0, top + 2);
        g.quadraticCurveTo(x0 - 5 * d, top + 2, x0 - 5 * d, top + 8);
        g.lineTo(x0 - 5 * d, m - 4);
        g.quadraticCurveTo(x0 - 5 * d, m, x0 - 9 * d, m);
        g.quadraticCurveTo(x0 - 5 * d, m, x0 - 5 * d, m + 4);
        g.lineTo(x0 - 5 * d, gy - 8);
        g.quadraticCurveTo(x0 - 5 * d, gy - 2, x0, gy - 2);
      }
      g.stroke();
    } else if (o.k === 'tag') {
      // </>
      const m = gy - o.h / 2;
      g.moveTo(x + 12, top + 3);
      g.lineTo(x + 2, m);
      g.lineTo(x + 12, gy - 3);
      g.moveTo(x + 25, top + 1);
      g.lineTo(x + 17, gy - 1);
      g.moveTo(x + 30, top + 3);
      g.lineTo(x + 40, m);
      g.lineTo(x + 30, gy - 3);
      g.stroke();
    } else {
      // A big ;
      g.arc(x + 8, top + 7, 6.5, 0, Math.PI * 2);
      g.moveTo(x + 14.5, gy - 17);
      g.arc(x + 8, gy - 17, 6.5, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(x + 13, gy - 15);
      g.quadraticCurveTo(x + 12, gy - 4, x + 4, gy - 1);
      g.stroke();
    }
  }
}
