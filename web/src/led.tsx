import { useEffect, useRef, useState } from 'react';

// Local copy: importing it from bits.tsx makes a cycle, since bits renders Led.
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// A 3x3 LED panel: each activity plays its own pattern at 20 fps, and lit dots keep an afterglow.
export type LedPattern = 'think' | 'search' | 'read' | 'edit' | 'run' | 'needs' | 'mark' | 'check' | 'calm' | 'fault' | 'delegating';
// The robot's own panels: its eyes at rest (the floor is the eyelid) and a dark panel for the boot self-test.
// 'listen' is voice input's own panel; it stays out of LedPattern, which the robot's states mirror.
export type AnyPattern = LedPattern | 'eyes' | 'dark' | 'listen';

// The working line's text decides the pattern: "Reading x" reads, "Running x" runs.
export function activityOf(step: string | undefined): LedPattern {
  if (!step) return 'think';
  if (/^(Reading|Fetching)\b/.test(step)) return 'read';
  if (/^Searching\b/.test(step)) return 'search';
  if (/^(Editing|Writing)\b/.test(step)) return 'edit';
  if (/^(Running|Stopping|Starting)\b/.test(step)) return 'run';
  return 'think';
}

const RING = [0, 1, 2, 5, 8, 7, 6, 3];
const T_DOTS = [1, 3, 4, 5, 7, 8];
const CHECK = [3, 7, 5, 2];
const XS = [0, 2, 4, 6, 8];

type Pattern = { tau: number; still: number[]; floor?: Record<number, number>; lidded?: boolean; step(m: Matrix): void };
const PATTERNS: Record<AnyPattern, Pattern> = {
  think: { tau: 0.38, still: [4], step(m) { if (m.k % 4 === 0) { let i; do i = (Math.random() * 9) | 0; while (i === m.last); m.last = i; m.hit(i, 1); } } },
  search: { tau: 0.2, still: [4, 1, 2], floor: { 4: 0.22 }, step(m) { if (m.k % 2 === 0) m.hit(RING[(m.k / 2) % 8], 1); } },
  read: { tau: 0.13, still: [0, 1, 2], step(m) { const c = ((m.k / 2) | 0) % 12; if (m.k % 2 === 0 && c < 9) m.hit(c, 1); } },
  edit: { tau: 0.16, still: [0, 1, 2, 3, 4], step(m) { if (m.k % 3) return; const c = ((m.k / 3) | 0) % 13; if (c < 9) { m.hold.add(c); m.hit(c, 1); } if (c === 12) m.hold.clear(); } },
  run: { tau: 0.14, still: [3, 4, 5], step(m) { const c = ((m.k / 2) | 0) % 4; if (m.k % 2 === 0 && c < 3) for (const r of [0, 1, 2]) m.hit(r * 3 + c, r === 1 ? 1 : 0.75); } },
  needs: { tau: 0.2, still: RING, step(m) { const b = 0.62 + 0.38 * (0.5 + 0.5 * Math.cos((m.k / 20) * Math.PI)); for (const i of RING) m.b[i] = Math.max(m.b[i], m.k < 12 ? 1 : b); } },
  mark: { tau: 0.2, still: T_DOTS, step(m) { for (const i of T_DOTS) m.b[i] = 1; } },
  check: { tau: 0.25, still: CHECK, step(m) { CHECK.forEach((i, n) => { if (m.k >= n * 1.4) m.b[i] = 1; }); } },
  // Voice input: a ripple from the center out, like sound reaching a mic. Not a level meter, so it claims no loudness.
  listen: { tau: 0.2, still: [1, 3, 4, 5, 7], step(m) { const c = m.k % 18; if (c === 0) m.hit(4, 1); if (c === 3) for (const i of [1, 3, 5, 7]) m.hit(i, 0.8); if (c === 6) for (const i of [0, 2, 6, 8]) m.hit(i, 0.5); } },
  // Everything live that is not the newest thing on screen: one dot breathing, so a busy panel stays calm.
  calm: { tau: 0.5, still: [4], step(m) { const b = 0.5 + 0.4 * (0.5 + 0.5 * Math.cos((m.k / 32) * Math.PI)); m.b[4] = Math.max(m.b[4], b); for (const i of [1, 3, 5, 7]) m.b[i] = Math.max(m.b[i], b * 0.3); } },
  // Idle while subagents work: one dot glides round the edge, 2.4 s a lap, centre dark. Slower and smoother than search.
  delegating: { tau: 0.32, still: [1, 3, 5, 7], step(m) {
    const p = (m.k % 48) / 6, i = p | 0, f = p - i, a = RING[i], b = RING[(i + 1) % 8];
    m.b[a] = Math.max(m.b[a], 0.9 * Math.sqrt(1 - f));
    m.b[b] = Math.max(m.b[b], 0.9 * Math.sqrt(f));
  } },
  // An error: the X strobes, then throbs dim with a stray flicker.
  fault: { tau: 0.07, still: XS, step(m) {
    if (m.k <= 10) { if (m.k % 2 === 0) for (const i of XS) m.hit(i, 1.25); return; }
    const b = 0.42 + 0.16 * (0.5 + 0.5 * Math.cos((m.k / 8) * Math.PI));
    for (const i of XS) m.b[i] = Math.max(m.b[i], b);
    if (Math.random() < 0.04) m.hit(XS[(Math.random() * 5) | 0], 1);
  } },
  eyes: { tau: 0.06, still: [3, 5], floor: { 3: 1, 5: 1 }, lidded: true, step() {} },
  dark: { tau: 0.22, still: [], step() {} },
};
// Patterns that settle: once their dots stop moving the loop can sleep.
const SETTLES = new Set<AnyPattern>(['eyes', 'dark']);

export class Matrix {
  b = new Float32Array(9);
  k = 0;
  acc = 0;
  last = -1;
  hold = new Set<number>();
  name: AnyPattern;
  p: Pattern;
  // The robot's hooks: a dot going from dark to lit reports itself, and the eyelid closes the eyes' floor.
  onHit: ((i: number) => void) | null = null;
  lid = 0;
  // Per-eye lids (3: left, 5: right) for a wink or a squint; `lid` closes both.
  lidL = 0;
  lidR = 0;
  busy = true;
  constructor(name: AnyPattern) {
    this.name = name;
    this.p = PATTERNS[name];
  }
  set(name: AnyPattern) {
    if (name === this.name) return;
    this.reset(name);
  }
  reset(name: AnyPattern) {
    this.name = name;
    this.p = PATTERNS[name];
    this.k = 0;
    this.hold.clear();
    this.busy = true;
  }
  hit(i: number, v: number) {
    if (this.b[i] < 0.5 && v >= 0.75) this.onHit?.(i);
    this.b[i] = Math.max(this.b[i], v);
  }
  update(dt: number) {
    this.acc += dt;
    while (this.acc >= 0.05) {
      this.acc -= 0.05;
      this.k++;
      this.p.step(this);
    }
    const f = Math.exp(-dt / this.p.tau);
    const lidded = !!this.p.lidded;
    let moved = 0;
    for (let i = 0; i < 9; i++) {
      const open = lidded ? 1 - Math.max(this.lid, i === 3 ? this.lidL : i === 5 ? this.lidR : 0) : 1;
      const v = Math.max(this.b[i] * f, (this.p.floor?.[i] ?? 0) * open, this.hold.has(i) ? 1 : 0);
      moved = Math.max(moved, Math.abs(v - this.b[i]));
      this.b[i] = v;
    }
    this.busy = !SETTLES.has(this.name) || moved > 1e-3;
  }
  still() {
    this.b.fill(0);
    for (const i of this.p.still) this.b[i] = 1;
  }
}

// One rAF loop for every LED on the page; it stops when nothing subscribes or the tab is hidden.
const subs = new Set<(dt: number) => void>();
let raf = 0;
let last = 0;
const frame = (now: number) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const f of [...subs]) f(dt);
  raf = subs.size && !document.hidden ? requestAnimationFrame(frame) : 0;
};
const kick = () => {
  if (raf || !subs.size || document.hidden) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
};
document.addEventListener('visibilitychange', kick);
export function tick(fn: (dt: number) => void) {
  subs.add(fn);
  kick();
  return () => void subs.delete(fn);
}

// One IntersectionObserver for every LED; callbacks get the visibility only, never the element.
const seen = new Map<Element, (visible: boolean) => void>();
let io: IntersectionObserver | null = null;
export function watch(el: Element, fn: (visible: boolean) => void) {
  io ??= new IntersectionObserver((es) => {
    for (const e of es) seen.get(e.target)?.(e.isIntersecting);
  });
  seen.set(el, fn);
  io.observe(el);
  return () => {
    seen.delete(el);
    io?.unobserve(el);
  };
}

// Canvases cannot read CSS variables, so the accent and ink are read once per theme.
let themeOn = '232 182 76';
let themeOff = '220 215 204';
let read = false;
// Canvases that are not ticking would keep the old theme's colors, so they repaint here.
const redraws = new Set<() => void>();
export const onTheme = (fn: () => void) => {
  redraws.add(fn);
  return () => void redraws.delete(fn);
};
const readColors = () => {
  const cs = getComputedStyle(document.documentElement);
  themeOn = cs.getPropertyValue('--coral-rgb').trim() || themeOn;
  themeOff = cs.getPropertyValue('--ink-rgb').trim() || '43 42 39';
  read = true;
  for (const fn of redraws) fn();
};
const themeWatch = new MutationObserver(readColors);
themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
import.meta.hot?.dispose(() => {
  themeWatch.disconnect();
  io?.disconnect();
  document.removeEventListener('visibilitychange', kick);
  cancelAnimationFrame(raf);
});

export function paint(ctx: CanvasRenderingContext2D, b: ArrayLike<number>, x0: number, y0: number, dot: number, gap: number, glow = 1, colors?: { on: string; off: string }) {
  if (!read) readColors();
  const on = colors?.on ?? themeOn;
  const off = colors?.off ?? themeOff;
  for (let i = 0; i < 9; i++) {
    const x = x0 + (i % 3) * (dot + gap) + dot / 2;
    const y = y0 + ((i / 3) | 0) * (dot + gap) + dot / 2;
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgb(${off} / .15)`;
    ctx.beginPath();
    ctx.arc(x, y, dot / 2, 0, 7);
    ctx.fill();
    const v = b[i];
    if (v > 0.01) {
      ctx.shadowColor = `rgb(${on} / ${Math.min(0.9, 0.9 * v)})`;
      ctx.shadowBlur = dot * 1.6 * Math.min(v, 2) * glow;
      ctx.fillStyle = `rgb(${on} / ${Math.min(1, v * 1.05)})`;
      ctx.beginPath();
      ctx.arc(x, y, dot / 2, 0, 7);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
}

// Dot size and gap per use: sm for inline marks; md and lg are larger panels.
const SIZES = { sm: [2.6, 1.5], md: [3.6, 2.1], lg: [26, 15] } as const;
type Size = keyof typeof SIZES;
const PAD = 3;

function useCanvas(size: Size) {
  const [dot, gap] = SIZES[size];
  const box = dot * 3 + gap * 2;
  const css = Math.ceil(box + PAD * 2);
  return { dot, gap, css, x0: (css - box) / 2 };
}

// The LED itself: decorative, so it is aria-hidden; the state lives in text next to it.
// `still` draws the pattern's resting frame once and never joins the ticker.
export function Led({ pattern, size = 'md', still = false }: { pattern: LedPattern | 'listen'; size?: Size; still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [m] = useState(() => new Matrix(pattern));
  const draw = useRef<() => void>(() => {});
  const g = useCanvas(size);

  useEffect(() => {
    m.set(pattern);
    if (still || reduceMotion()) {
      m.still();
      draw.current();
    }
  }, [m, pattern, still]);

  useEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = cv.height = g.css * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    draw.current = () => {
      ctx.clearRect(0, 0, g.css, g.css);
      paint(ctx, m.b, g.x0, g.x0, g.dot, g.gap, size === 'sm' ? 0.7 : 1);
    };
    const offTheme = onTheme(() => draw.current());
    if (still || reduceMotion()) {
      m.still();
      draw.current();
      return offTheme;
    }
    // Only an LED on screen runs.
    let stop: (() => void) | null = null;
    const unwatch = watch(cv, (visible) => {
      if (visible && !stop) stop = tick((dt) => (m.update(dt), draw.current()));
      else if (!visible && stop) (stop(), (stop = null));
    });
    return () => {
      offTheme();
      unwatch();
      stop?.();
    };
  }, [m, size, g.css, g.dot, g.gap, g.x0, still]);

  return <canvas ref={ref} className={`led ${size}`} style={{ width: g.css, height: g.css }} aria-hidden="true" />;
}

// A still 3x3 used as a gauge: dots fill in reading order, and a newly lit dot flashes, then settles.
export function LedGauge({ value }: { value: number | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useRef({ b: new Float32Array(9), n: 0, draw: () => {}, stop: null as (() => void) | null });
  const g = useCanvas('sm');

  useEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = cv.height = g.css * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    st.current.draw = () => {
      ctx.clearRect(0, 0, g.css, g.css);
      paint(ctx, st.current.b, g.x0, g.x0, g.dot, g.gap, 0.8);
    };
    st.current.draw();
    const offTheme = onTheme(() => st.current.draw());
    return () => {
      offTheme();
      st.current.stop?.();
    };
  }, [g.css, g.dot, g.gap, g.x0]);

  useEffect(() => {
    const s = st.current;
    const next = value === null ? 0 : Math.max(value > 0 ? 1 : 0, Math.min(9, Math.round((value / 100) * 9)));
    const still = reduceMotion();
    for (let i = s.n; i < next; i++) s.b[i] = still ? 0.85 : 2.2;
    for (let i = next; i < 9; i++) s.b[i] = 0;
    for (let i = 0; i < Math.min(s.n, next); i++) s.b[i] = Math.max(s.b[i], 0.85);
    s.n = next;
    s.draw();
    if (still || s.stop) return;
    s.stop = tick((dt) => {
      let busy = false;
      for (let i = 0; i < s.n; i++) {
        if (s.b[i] > 0.86) {
          s.b[i] = 0.85 + (s.b[i] - 0.85) * Math.exp(-dt / 0.18);
          busy = true;
        }
      }
      s.draw();
      if (!busy) (s.stop?.(), (s.stop = null));
    });
  }, [value]);

  return <canvas ref={ref} className="led sm gauge" style={{ width: g.css, height: g.css }} aria-hidden="true" />;
}

// Determinate progress as a row of LEDs: done dots lit, the current one breathing, a new one lands with a flash.
export function LedBar({ done, total }: { done: number; total: number }) {
  const n = Math.max(1, Math.min(total, 24));
  const k = total > 24 ? Math.round((done / total) * n) : done;
  // Dots lit by the latest change, in dot space; only they carry the landing flash.
  const [prev, setPrev] = useState(k);
  const [land, setLand] = useState<[number, number]>([k, k]);
  if (k !== prev) {
    setPrev(k);
    setLand(k > prev ? [prev, k] : [k, k]);
  }
  return (
    <span className="ledbar" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < k ? (i >= land[0] && i < land[1] ? 'on land' : 'on') : i === k ? 'cur' : undefined} />
      ))}
    </span>
  );
}

// The favicon: the robot's small mark (svg/mark-small.svg, a 32-unit grid) with the matrix in its dots.
export function drawFavicon(ctx: CanvasRenderingContext2D, S: number, m: Matrix, eyeFloor = 0) {
  const u = S / 32;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#1e1d1a';
  ctx.beginPath();
  ctx.roundRect(0, 0, S, S, 7 * u);
  ctx.fill();
  for (let s = 0; s < 3; s++) {
    const x = 6 + s * 10;
    const dy = s === 2 ? 2 : 0;
    ctx.fillStyle = '#3d3a34';
    ctx.beginPath();
    ctx.roundRect((x - 4) * u, (5 + dy) * u, 8 * u, 21 * u, u);
    ctx.fill();
    for (let k = 0; k < 3; k++) {
      const i = k * 3 + s;
      const c = i === 4;
      const cx = x * u;
      const cy = ([9, 15.5, 22][k] + dy) * u;
      ctx.fillStyle = '#6a6358';
      ctx.beginPath();
      ctx.arc(cx, cy, (c ? 1 : 1.7) * u, 0, 7);
      ctx.fill();
      const b = i === 3 || i === 5 ? Math.max(m.b[i], eyeFloor) : m.b[i];
      if (b < 0.01) continue;
      const r = (c ? 3 : 4.6) * u;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0.3, `rgb(232 182 76 / ${0.6 * Math.min(0.9, 0.9 * b)})`);
      g.addColorStop(1, 'rgb(232 182 76 / 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 7);
      ctx.fill();
      ctx.fillStyle = `rgb(242 194 85 / ${Math.min(1, b * 1.05)})`;
      ctx.beginPath();
      ctx.arc(cx, cy, (c ? 1.5 : 2.6) * u, 0, 7);
      ctx.fill();
    }
  }
}
