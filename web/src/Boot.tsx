import { useEffect, useRef, useState } from 'react';
import { ambient, useAmbient } from './perf.ts';
import { useStore } from './store.ts';
import { Robot } from './robot.tsx';
import { Flap } from './flap.tsx';

const NAME = 'tarcsweb';
const BLANK = ' '.repeat(NAME.length);
const NAME_HOPS: [number, number] = [2, 5];
const SIZE = 96;
const U = SIZE / 512;
// The boot starts dark: the prototype's first tenth powers the robot down, and here there is nothing to power down.
const FROM_DARK = 0.1;
// After the name starts flipping, how long the intro holds before the robot leaves for his seat.
const HOLD_MS = 800;
// How long to wait for his seat to render before fading out in place instead.
const SEAT_WAIT_MS = 1200;
const FLY_MS = 900;
// If the robot never reports (a tab hidden mid-boot), the intro still leaves.
const MAX_MS = 4200;
// His body's centre in the 512 box, and the seats' click-box width there (strip 420, hero 416).
const BODY = { x: 256, y: 253 };
const HIT_W = 418;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
// Where t sits inside the window [a, b], as 0..1.
const win = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeOut = (v: number) => 1 - (1 - v) ** 3;
const easeInOut = (v: number) => 0.5 - Math.cos(Math.PI * v) / 2;

function shouldBoot() {
  return !ambient() && !document.hidden && !new URLSearchParams(location.search).has('embed');
}

type Seat = { hit: HTMLElement; body: HTMLElement };
// His place in the app: the big Start robot when it shows, else the strip above the composer.
function findSeat(): Seat | null {
  for (const sel of ['.rbt-poke', '.rstrip']) {
    for (const host of document.querySelectorAll<HTMLElement>(sel)) {
      const hit = host.querySelector<HTMLElement>(':scope > .rbt-hit');
      const body = host.querySelector<HTMLElement>(':scope > .rbt');
      const r = hit?.getBoundingClientRect();
      if (hit && body && r && r.width > 0 && r.bottom > 0 && r.top < innerHeight) return { hit, body };
    }
  }
  return null;
}

// Every app open, and again when the server restarts under an open page: the robot powers on, the name flips in,
// then he hops in an arc to his seat while the app shows through. A click or key skips it.
export function Boot() {
  const [on, setOn] = useState(shouldBoot);
  const [again, setAgain] = useState(false);
  const [name, setName] = useState(BLANK);
  const root = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const bot = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const leave = useRef<(ms: number) => void>(() => {});
  const handoff = useRef<() => void>(() => {});
  const fade = useRef(0);

  // A new serverId means the server restarted; a dropped connection that comes back keeps the old one.
  const serverId = useStore((s) => s.serverId);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!serverId) return;
    const prev = seen.current;
    seen.current = serverId;
    if (!prev || prev === serverId || on || !shouldBoot()) return;
    setName(BLANK);
    setAgain(true);
    setOn(true);
  }, [serverId, on]);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    let gone = false;
    let raf = 0;
    let seat: Seat | null = null;
    const done = () => {
      if (seat) seat.body.style.opacity = '';
      seat = null;
      if (alive) setOn(false);
    };
    leave.current = (ms: number) => {
      if (gone) return;
      gone = true;
      clearTimeout(fade.current);
      cancelAnimationFrame(raf);
      // The real robot comes back at once; the flying copy fades over it.
      if (seat) seat.body.style.opacity = '';
      const el = root.current;
      if (!el) return done();
      // Clicks pass through as soon as it starts to fade.
      el.style.pointerEvents = 'none';
      el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' }).finished.then(done, () => {});
    };

    // One progress value drives the hop: an arc toward the seat measured every frame, so a moving target still lands.
    const fly = (to: Seat) => {
      const el = root.current, b = bot.current, back = bg.current;
      if (!el || !b || !back) return leave.current(220);
      seat = to;
      el.style.pointerEvents = 'none';
      to.body.style.opacity = '0';
      const r = b.getBoundingClientRect();
      const x0 = r.left + BODY.x * U, y0 = r.top + BODY.y * U;
      const start = performance.now();
      const frame = (now: number) => {
        if (gone) return;
        const t = clamp01((now - start) / FLY_MS);
        const h = to.hit.getBoundingClientRect();
        if (!h.width) return leave.current(120);
        const x2 = h.left + h.width / 2, y2 = h.top + h.height / 2;
        const scale = (h.width * 512) / HIT_W / SIZE;
        // A shallow toss: the control point rises above the higher end, so he hops up before he lands.
        const lift = Math.min(140, Math.max(40, Math.hypot(x2 - x0, y2 - y0) * 0.2));
        const x1 = (x0 + x2) / 2, y1 = Math.min(y0, y2) - lift;
        const u = easeInOut(t), v = 1 - u;
        const x = v * v * x0 + 2 * v * u * x1 + u * u * x2;
        const y = v * v * y0 + 2 * v * u * y1 + u * u * y2;
        const lean = Math.sign(x2 - x0) * 8 * Math.sin(Math.PI * u);
        b.style.transform = `translate3d(${(x - x0).toFixed(1)}px,${(y - y0).toFixed(1)}px,0) rotate(${lean.toFixed(2)}deg) scale(${(1 + (scale - 1) * u).toFixed(4)})`;
        back.style.opacity = String(1 - easeOut(win(t, 0.12, 0.7)));
        const n = easeOut(win(t, 0, 0.3));
        if (label.current) {
          label.current.style.opacity = String(1 - n);
          label.current.style.transform = `translateY(${(8 * n).toFixed(1)}px)`;
        }
        // The last stretch cross-fades into the real robot, which sits exactly under him by then.
        const swap = win(t, 0.86, 1);
        b.style.opacity = String(1 - swap);
        to.body.style.opacity = String(swap);
        if (t < 1) raf = requestAnimationFrame(frame);
        else {
          gone = true;
          done();
        }
      };
      raf = requestAnimationFrame(frame);
    };

    handoff.current = () => {
      const until = performance.now() + SEAT_WAIT_MS;
      const look = (now: number) => {
        if (gone) return;
        const to = findSeat();
        if (to) return fly(to);
        if (now > until) return leave.current(220);
        raf = requestAnimationFrame(look);
      };
      raf = requestAnimationFrame(look);
    };

    fade.current = window.setTimeout(() => leave.current(220), MAX_MS);
    // Any click or key skips the intro, so it never stands between the user and the app.
    const skip = () => leave.current(120);
    addEventListener('pointerdown', skip, true);
    addEventListener('keydown', skip, true);
    return () => {
      alive = false;
      gone = true;
      clearTimeout(fade.current);
      cancelAnimationFrame(raf);
      if (seat) seat.body.style.opacity = '';
      removeEventListener('pointerdown', skip, true);
      removeEventListener('keydown', skip, true);
    };
  }, [on]);

  // Lite arriving from the server mid-intro: a still robot never reaches the mark, so leave now.
  const calm = useAmbient();
  useEffect(() => {
    if (calm) leave.current(120);
  }, [calm]);

  // The self-test ends on the mark: the name starts flipping, holds a moment, then he leaves for his seat.
  const onCue = (c: string) => {
    if (c !== 'mark') return;
    setName(NAME);
    clearTimeout(fade.current);
    fade.current = window.setTimeout(() => handoff.current(), HOLD_MS);
  };

  if (!on) return null;
  return (
    <div className={`boot${again ? ' again' : ''}`} ref={root} aria-hidden="true">
      <div className="boot-bg" ref={bg}></div>
      <div className="boot-row">
        <span className="boot-bot" ref={bot} style={{ width: SIZE, height: SIZE }}>
          <Robot size={SIZE} state="boot" from={FROM_DARK} lead pin onCue={onCue} />
        </span>
        <span className="boot-name" ref={label}><Flap tiles text={name} hops={NAME_HOPS} /></span>
      </div>
    </div>
  );
}
