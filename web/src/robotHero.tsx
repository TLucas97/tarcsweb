import { useLayoutEffect, useRef } from 'react';
import { HERO } from './bits.tsx';
import { useAmbient } from './perf.ts';
import { Rig, clamp, joinLeads, pulse, rand, type Move, type Reach } from './robot.tsx';
import { Director, MOVES as SHARED, caretAt, gait, gaitFn, type Table } from './robotDirector.ts';
import { PokeButton } from './robotStrip.tsx';

// The big idle robot on the Start page and in an empty session. Same director as the strip robot, but he stays in
// his box: in-place acts, a short side step, light signals, and only now and then a glance at the pointer.

// The canvas reaches past the box: a flip needs room above the head; the sides keep the default bleed.
const REACH: Reach = { l: 64, t: 200, w: 640, h: 512 + 200 + 64 };
const PACE = { first: [1.5, 3], rest: [3, 6.5], small: [2.4, 4.5], typing: [4.5, 8] } as const;
const PAUSE = 1.2;
const STEP = { SD: 0.3, SW: 0.24, stag: 0.07, stride: 120, T0: 0.08, tail: 0.2 };

const mv = (r: Rig) => r.move!;
const MOVES: Record<string, Move> = {
  ...SHARED,
  // One shuffle to a side inside the box, a look around, and back. Positions in units.
  sideStep: {
    name: 'Side Step', dur: 4,
    enter(r) {
      const m = mv(r), x = (m.d = Math.random() < 0.5 ? -1 : 1) * rand(36, 54);
      r.wx = 0;
      m.trip = gait(0, x, STEP);
      m.back = gait(x, 0, STEP);
      m.dur = m.trip.dur + PAUSE + m.back.dur;
    },
    seq(r, s, o) {
      const m = mv(r), a = m.trip!, s2 = s - a.dur - PAUSE;
      gaitFn(r, s2 < 0 ? a : m.back!, o, s2 < 0 ? s : s2);
      o['b.x'] = r.wx;
      o['row0.r'] = 9 * m.d * pulse(s, a.dur - 0.1, a.dur + 0.3, a.dur + PAUSE);
      if (s > a.dur && !m.seen.has(0)) (m.seen.add(0), r.fx.hit(m.d > 0 ? 5 : 3, 1.3));
    },
  },
  // The scan line sweeps the face once.
  scan: {
    name: 'Scan', dur: 1.3,
    enter(r) {
      r.C.hy.x = 70;
      r.C.hy.v = 0;
      r.tgt('hy', 450);
      r.tgt('ho', 0.7);
      r.later(0.7, () => r.tgt('ho', 0), 'move');
    },
  },
};
// [weight, cooldown s]. Calm acts lead; spins and partial rotations come next; poses and the flip are rare.
const BIG: Table = {
  sideStep: [2.4, 12], headTilt: [1.4, 14], nod: [0.8, 18], peek: [0.9, 24],
  hipSwing: [1, 18], twist: [1.2, 18], propeller: [1, 28], ratchet: [0.8, 36], flapWave: [0.8, 26], ripple: [1, 18], scramble: [0.35, 60],
  hop: [0.9, 20], flip: [0.2, 150], doubleTake: [0.5, 40], wave: [0.7, 35], stretch: [0.5, 50], shakeOff: [0.7, 30],
  column: [0.3, 45], cheer: [0.35, 45], arch: [0.25, 50], arrow: [0.5, 35], bow: [0.3, 50], curious: [0.7, 30], surprised: [0.25, 70], heart: [0.2, 120],
  exploded: [0.15, 90], sleepy: [0.25, 120], visor: [0.35, 60], roof: [0.25, 70], stairs: [0.25, 60],
};
const SMALL: Table = { glance: [5, 0], wink: [1, 20], ping: [0.7, 25], ellipsis: [0.6, 30], sparkle: [0.8, 20], pointTo: [0.5, 30], twitch: [1.4, 0], fix: [0.6, 18], sway: [1.2, 12], scan: [0.6, 25] };
// Typing: in place and quiet; the look at the composer comes once, on the first key of a burst.
const TYPING: Table = { sway: [1.5, 9], twitch: [1.5, 0], wink: [1, 18], ping: [0.6, 25], sparkle: [0.5, 25], ellipsis: [0.8, 20], fix: [0.4, 20] };

// His body's click box in px: the slabs (60..452 by 62..447 units) plus a little margin.
const U = HERO / 512;
const HIT = { left: 48 * U, top: 52 * U, width: 416 * U, height: 402 * U };

// The canvas is decorative (aria-hidden); the page's heading says where you are. A button over his body makes him clickable.
export function HeroRobot() {
  const host = useRef<HTMLSpanElement>(null);
  const hit = useRef<HTMLButtonElement>(null);
  const director = useRef<Director | null>(null);
  const calm = useAmbient();

  // Before paint, so he never shows unposed.
  useLayoutEffect(() => {
    const el = host.current!, btn = hit.current!;
    const r = new Rig(el, { level: 'full', px: HERO, tile: false, still: calm, reach: REACH, cue: () => {} });
    // The click box follows his side steps.
    let tx = '';
    r.onStep = () => {
      const t = `translateX(${(r.V('b.x') * U).toFixed(1)}px)`;
      if (t !== tx) (btn.style.transform = t), (tx = t);
    };
    r.set('idle', null, { quiet: true, force: true });
    r.render();
    const unlead = joinLeads(r);
    const around = (x: number, y: number) => {
      const b = el.getBoundingClientRect();
      return { nx: clamp((x - (b.left + b.width / 2)) / 360, -1, 1), ny: clamp((y - (b.top + b.height / 2)) / 360, -1, 1) };
    };
    const dir = new Director(r, {
      moves: MOVES, big: BIG, small: SMALL, typing: TYPING, pace: PACE,
      headroom: () => REACH.t + 62,
      around,
      caret: () => {
        const c = caretAt();
        return c ? around(c.x, c.y) : { nx: 0, ny: 1 };
      },
      busy: () => false,
    });
    dir.start();
    director.current = dir;
    return () => {
      director.current = null;
      dir.destroy();
      unlead();
      r.destroy();
      el.replaceChildren();
    };
  }, [calm]);

  return (
    <span className="rbt-poke">
      <span ref={host} className="rbt full" style={{ width: HERO, height: HERO }} aria-hidden="true" />
      <PokeButton ref={hit} style={HIT} poke={() => director.current?.poke()} greet={() => director.current?.greet()} />
    </span>
  );
}
