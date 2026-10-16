import { useEffectEvent, useLayoutEffect, useRef, type CSSProperties, type Ref } from 'react';
import type { AnyPattern, LedPattern } from './led.tsx';
import { reduceMotion } from './bits.tsx';
import { Rig, STRIP_REACH, clamp, joinLeads, ledOf, rand, type Move, type RobotState } from './robot.tsx';
import { Director, MOVES as SHARED, caretAt, gait, roll, travel, trip, type Table } from './robotDirector.ts';

// The robot on the strip above the composer (notes/identity/logo/round3/composer). Idle he wanders on the floor;
// a turn sends him to the start spot, where he hops up and hovers by the working line until it ends.

const SIZE = 48;
const U = SIZE / 512;
const FLOOR_GAP = 2;
// His body's click box in 512 units: the slabs (60..452 by 62..447) plus a little margin.
const HIT = { x: 46, y: 50, w: 420, h: 405 };
// Centre of the working line's row, from the strip's top (styles.css: .rstrip .working); his middle dots sit on it.
const ROW_Y = 21;
// Idle pace in seconds. Free: a rest after each big act, small acts in between; typing: small in-place acts only.
const PACE = { first: [2, 4], rest: [1.6, 4.8], small: [2.4, 4.5], typing: [4.5, 8] } as const;
// Stroll speeds: [weight, min px, max px, gait]. Faster gaits go further.
const GAITS: [number, number, number, Parameters<typeof gait>[2]][] = [
  [3, 90, 220, { SD: 0.34, SW: 0.25, stride: 110 }],
  [3, 160, 360, { SD: 0.28, SW: 0.21, stag: 0.07, stride: 125 }],
  [1.5, 240, 480, { SD: 0.22, SW: 0.17, stag: 0.055, stride: 150 }],
];

const strips = new WeakMap<Rig, Strip>();
const st = (r: Rig) => strips.get(r)!;
const mv = (r: Rig) => r.move!;
function roomTarget(r: Rig, lo: number, hi: number, a: number, b: number) {
  const d = hi - r.wx > r.wx - lo ? (Math.random() < 0.7 ? 1 : -1) : Math.random() < 0.7 ? -1 : 1;
  let to = clamp(r.wx + d * rand(a, b), lo, hi);
  if (Math.abs(to - r.wx) < a * 0.6) to = clamp(r.wx - d * rand(a, b), lo, hi);
  return to;
}

// The shared catalogue plus travel along the strip.
const MOVES: Record<string, Move> = {
  ...SHARED,
  stroll: {
    name: 'Stroll', dur: 3,
    enter(r) {
      const [to, o] = st(r).strollTo(), t = gait(r.wx, to, o, U);
      Object.assign(mv(r), { trip: t, dur: t.dur });
    },
    seq: travel,
  },
  scoot: {
    name: 'Scoot', dur: 1.4,
    enter(r) {
      const g = st(r), to = roomTarget(r, g.xStart() + 30, g.xMax(), 220, 760);
      const t = roll(r.wx, to, clamp(0.8 + Math.abs(to - r.wx) / 450, 0.9, 1.6), U);
      Object.assign(mv(r), { trip: t, dur: t.dur });
      r.light('ring', t.dur * 0.8);
    },
    seq: travel,
  },
  // Turn start: two quick steps when close, a fast roll when far; never more than half a second.
  dash: {
    name: 'Dash to start', dur: 0.5,
    enter(r) {
      const to = st(r).xStart(), ad = Math.abs(to - r.wx);
      const t = ad < 2 ? trip({ from: to, to }) : ad < 44
        ? gait(r.wx, to, { SD: 0.1, SW: 0.13, stag: 0.025, stride: 260, T0: 0.01, tail: 0.04 }, U)
        : roll(r.wx, to, clamp(0.3 + ad / 1500, 0.34, 0.5), U);
      if (t.kind === 'none') r.wx = to;
      Object.assign(mv(r), { trip: t, dur: t.dur });
    },
    seq: travel,
    after: (r) => st(r).arrive(),
  },
};
// [weight, cooldown s]. Free tier: travel, spins and partial rotations lead; poses are rarer and held briefly.
const BIG: Table = {
  stroll: [10, 0], scoot: [0.8, 25],
  headTilt: [1.3, 14], hipSwing: [1.1, 18], twist: [1.3, 18], propeller: [1.1, 28], ratchet: [0.9, 36], flapWave: [0.8, 26], ripple: [0.9, 18], scramble: [0.35, 60],
  hop: [0.8, 22], flip: [0.2, 150], peek: [0.7, 28], nod: [0.6, 20], doubleTake: [0.4, 45], wave: [0.6, 40], stretch: [0.4, 60], shakeOff: [0.6, 35],
  column: [0.3, 45], cheer: [0.3, 45], arch: [0.25, 50], arrow: [0.5, 35], bow: [0.3, 50], curious: [0.6, 30], surprised: [0.25, 70], heart: [0.15, 120],
  exploded: [0.15, 90], sleepy: [0.2, 120], visor: [0.3, 60], roof: [0.25, 70], stairs: [0.25, 60],
};
const SMALL: Table = { glance: [3, 0], wink: [1, 20], ping: [0.6, 25], ellipsis: [0.6, 30], sparkle: [0.7, 20], pointTo: [0.5, 30], twitch: [1.6, 0], fix: [0.6, 18], sway: [1, 12] };
// Typing tier: in place only; nothing that walks, spins or lifts.
const TYPING: Table = { sway: [1.5, 9], twitch: [1.5, 0], wink: [1, 18], ping: [0.6, 25], sparkle: [0.5, 25], ellipsis: [0.8, 20], caretLook: [1, 8], fix: [0.4, 20] };
// States of a running turn: he hovers by the working line through all of them.
const WORK = new Set<RobotState>(['think', 'search', 'read', 'edit', 'run', 'needs', 'handoff', 'calm']);

// ---- The strip: geometry, the shared idle director and the turn. ----
class Strip {
  r: Rig;
  host: HTMLElement;
  dir: Director;
  W = 0;
  H = 64;
  private sized = false;
  private tf = '';
  private hit: HTMLElement;
  private ht = '';
  private clipped = -1;
  private onClip: (px: number) => void;
  private visitAt = -99;
  // Turn
  private goal: RobotState = 'idle';
  private led: LedPattern | undefined;
  private placed = false;
  private turn = false;
  private travel = false;
  private ro: ResizeObserver;
  private unlead: () => void;

  constructor(host: HTMLElement, hit: HTMLElement, still: boolean, onClip: (px: number) => void) {
    this.host = host;
    this.hit = hit;
    hit.style.width = `${HIT.w * U}px`;
    hit.style.height = `${HIT.h * U}px`;
    this.onClip = onClip;
    const r = new Rig(host, { level: 'mid', px: SIZE, tile: false, still, strip: true, cue: () => {} });
    this.r = r;
    strips.set(r, this);
    r.onStep = () => this.place();
    this.unlead = joinLeads(r);
    this.ro = new ResizeObserver(([e]) => this.resize(e.contentRect.width, e.contentRect.height));
    this.ro.observe(host);
    this.dir = new Director(r, {
      moves: MOVES, big: BIG, small: SMALL, typing: TYPING, pace: PACE,
      headroom: () => this.headroom(),
      around: (x, y) => this.around(x, y),
      caret: () => ({ nx: this.caretN(), ny: 0.9 }),
      busy: () => this.turn,
      // Wandering is the point of the strip: the longer since the last stroll, the likelier the next; a second leg in a row is rarer.
      weight: (id, w, again, last) => {
        if (id !== 'stroll') return again ? 0 : w;
        const now = r.now();
        return (again ? 0.35 : 1) * w * (1 + (now - (last ?? now - 8)) / 20);
      },
    });
  }
  destroy() {
    this.ro.disconnect();
    this.dir.destroy();
    this.unlead();
    this.r.destroy();
  }

  floorY() {
    return this.H - FLOOR_GAP;
  }
  // Start spot: the body's left edge lines up with the conversation's text column.
  xStart() {
    return 4 - 60 * U;
  }
  xMax() {
    return Math.max(this.xStart(), this.W - 452 * U - 6);
  }
  // Room above the head, in 512 units.
  headroom() {
    return this.floorY() / U - 381;
  }
  // Hover height: his middle dot row on the working line's row.
  hoverLift() {
    return Math.max(0, (this.floorY() - 181 * U - ROW_Y) / U);
  }
  private resize(w: number, h: number) {
    const r = this.r;
    this.W = w;
    this.H = h || this.H;
    if (!this.sized) {
      this.sized = true;
      if (!this.turn) r.wx = clamp(0.62 * w, this.xStart(), this.xMax());
    } else if (!this.turn) r.wx = clamp(r.wx, this.xStart(), this.xMax());
    if (r.hovering) r.snapLift(this.hoverLift());
    this.tf = '';
    this.place();
  }
  // One transform on the canvas, one clip on the working line; writes only when a value changes.
  private place() {
    const r = this.r;
    if (!r.cv || !this.sized) return;
    const tf = `translate3d(${(r.wx - STRIP_REACH.l * U).toFixed(2)}px,${(this.floorY() - (STRIP_REACH.t + 443) * U).toFixed(2)}px,0)`;
    if (tf !== this.tf) (r.cv.style.transform = tf), (this.tf = tf);
    // The click target rides on his body, hover included; the rest of the strip lets clicks through.
    const hy = this.floorY() - (443 - HIT.y) * U + (r.V('b.y') - r.hover()) * U;
    const ht = `translate3d(${(r.wx + HIT.x * U).toFixed(1)}px,${hy.toFixed(1)}px,0)`;
    if (ht !== this.ht) (this.hit.style.transform = ht), (this.ht = ht);
    // The line is revealed behind him as he passes, so he never sits on its text.
    const clip = Math.round(clamp(r.wx + 452 * U + 4 - (this.xStart() + 452 * U + 10), 0, 2000));
    if (clip !== this.clipped) (this.clipped = clip), this.onClip(clip);
  }
  private around(x: number, y: number) {
    const b = this.host.getBoundingClientRect(), cx = b.left + this.r.wx + 256 * U, cy = b.top + this.floorY() - 190 * U;
    return { nx: clamp((x - cx) / 360, -1, 1), ny: clamp((y - cy) / 360, -1, 1) };
  }
  private caretN() {
    const c = caretAt();
    if (!c) return 0;
    return clamp((c.x - (this.host.getBoundingClientRect().left + this.r.wx + 256 * U)) / 260, -1, 1);
  }

  // Where the next stroll goes and at what gait.
  strollTo(): [number, Parameters<typeof gait>[2]] {
    const r = this.r, lo = this.xStart() + 30, hi = this.xMax();
    const v = this.visit(lo, hi);
    if (v !== null) return [v, GAITS[Math.abs(v - r.wx) > 260 ? 2 : 1][3]];
    let w = Math.random() * GAITS.reduce((a, g) => a + g[0], 0), g = GAITS[0];
    for (const x of GAITS) if ((w -= x[0]) <= 0) (g = x), (w = Infinity);
    return [roomTarget(r, lo, hi, g[1], g[2]), g[3]];
  }
  // Now and then a stroll ends under a pointer resting just above the strip; it stops short, so it reads as a visit, not a chase.
  private visit(lo: number, hi: number) {
    const r = this.r, now = r.now(), p = this.dir.ptr;
    if (!p || now - this.dir.ptrT > 5 || now - this.visitAt < 14 || Math.random() > 0.4) return null;
    const b = this.host.getBoundingClientRect();
    if (p.y > b.top + 8 || p.y < b.top - 320 || p.x < b.left || p.x > b.right) return null;
    const c = p.x - b.left - 256 * U, d = Math.sign(c - r.wx);
    const to = clamp(r.wx + d * Math.min(460, Math.abs(c - r.wx) - 40), lo, hi);
    if (Math.abs(to - r.wx) < 40) return null;
    this.visitAt = now;
    return to;
  }

  // ---- Turn: the LED is the information and changes at once; the body catches up. ----
  want(name: RobotState, led: LedPattern | undefined) {
    const r = this.r, first = !this.placed;
    if (!first && name === this.goal && led === this.led) return;
    this.placed = true;
    this.goal = name;
    this.led = led;
    const work = WORK.has(name);
    if (work || name === 'done' || name === 'error') {
      // Opened mid-turn: he is already there.
      if (first) {
        this.turn = true;
        r.wx = this.xStart();
        r.set(name, led ?? null, { quiet: true, force: true });
        if (work) {
          r.hovering = true;
          r.snapLift(this.hoverLift());
        }
        return;
      }
      if (work && !this.turn) return this.send(led ?? ledOf(name));
      // Until he arrives the posture waits; the LED does not.
      if (this.travel) return r.set('travel', led ?? ledOf(name));
      return r.set(name, led ?? null);
    }
    this.turn = false;
    this.travel = false;
    if (r.move?.by === 'turn') r.stopMove();
    if (name === 'stopped') {
      r.set('stopped');
      r.fall();
      return;
    }
    r.set(name, led ?? null, { force: first });
    if (r.C.lift.x < 1 && !r.falling) return this.resume(first);
    r.onLand = () => ((r.onLand = null), this.resume(false));
    r.fall();
  }
  private send(led: AnyPattern) {
    const r = this.r;
    this.turn = true;
    this.travel = true;
    r.clearTimers('dir', 'dir2');
    r.set('travel', led);
    r.prime();
    this.dir.play('dash', 'turn');
  }
  arrive() {
    const r = this.r;
    this.travel = false;
    if (r.still || r.benched) r.wx = this.xStart();
    const g = this.goal;
    if (!this.turn) return;
    r.set(g, this.led ?? null);
    // A turn that ended before he got there reacts on the floor.
    if (WORK.has(g)) r.rise(this.hoverLift());
  }
  private resume(first: boolean) {
    const r = this.r;
    this.dir.lastYield = Math.max(this.dir.lastYield, r.now());
    this.dir.start();
    if (!first) r.blink();
  }
}

// The strip's robot: the canvas is decorative (aria-hidden), the state lives in the working line next to it.
// A button over his body makes him clickable.
export function StripRobot({ state, led, onClip }: { state: RobotState; led?: LedPattern; onClip: (px: number) => void }) {
  const host = useRef<HTMLSpanElement>(null);
  const hit = useRef<HTMLButtonElement>(null);
  const strip = useRef<Strip | null>(null);
  const clip = useEffectEvent((px: number) => onClip(px));

  // Layout effects, so the LED and the line change on the same frame.
  useLayoutEffect(() => {
    const el = host.current!;
    const s = new Strip(el, hit.current!, reduceMotion(), (px) => clip(px));
    strip.current = s;
    return () => {
      s.destroy();
      strip.current = null;
      el.replaceChildren();
    };
  }, []);
  useLayoutEffect(() => {
    strip.current?.want(state, led);
  }, [state, led]);

  return (
    <>
      <span ref={host} className="rbt rstrip-bot" aria-hidden="true" />
      <PokeButton ref={hit} poke={() => strip.current?.dir.poke()} greet={() => strip.current?.dir.greet()} />
    </>
  );
}

// The click target over a robot's body. Mouse down never takes focus, so the composer keeps the caret.
export function PokeButton({ ref, poke, greet, style }: { ref: Ref<HTMLButtonElement>; poke: () => void; greet: () => void; style?: CSSProperties }) {
  return (
    <button
      ref={ref}
      type="button"
      className="rbt-hit"
      aria-label="tarcsweb"
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onClick={poke}
      onPointerEnter={(e) => e.pointerType === 'mouse' && greet()}
    />
  );
}
