import { useEffect, useRef, useState } from 'react';
import { useStore } from './store.ts';
import { useAmbient } from './perf.ts';
import { activityOf, drawFavicon, Matrix, type LedPattern } from './led.tsx';

const S = 64;
// About 4 fps: each frame is a PNG encode, and a 16px icon does not need more.
const FRAME = 250;
const CHECK_MS = 1200;
const ACTIVE = new Set<LedPattern>(['think', 'search', 'read', 'edit', 'run']);
const EYE_FLOOR = 0.12;

type Fav = { link: HTMLLinkElement; idle: string; cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D; m: Matrix };

function create(): Fav {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  return { link, idle: link.getAttribute('href') ?? '', cv, ctx: cv.getContext('2d')!, m: new Matrix('eyes') };
}

// The tab icon plays the working line's pattern; idle goes back to the static mark in index.html.
export function useFavicon() {
  const needs = useStore((s) => s.roster.some((r) => r.needsYou));
  const working = useStore((s) => s.roster.some((r) => r.state === 'working'));
  const act = useStore((s) => activityOf(s.current ? s.maps[s.current]?.now : undefined));
  const [checking, setChecking] = useState(false);
  const was = useRef(false);
  const fav = useRef<Fav>(null);
  // Lite and reduced motion: one still frame per state, no encode timer.
  const calm = useAmbient();

  // A finished turn shows a check for a moment before the mark returns.
  useEffect(() => {
    if (working) return void (was.current = true);
    if (!was.current) return;
    was.current = false;
    setChecking(true);
    const t = setTimeout(() => setChecking(false), CHECK_MS);
    return () => clearTimeout(t);
  }, [working]);

  const want: LedPattern | null = needs ? 'needs' : working ? act : checking ? 'check' : null;

  useEffect(() => {
    const f = (fav.current ??= create());
    if (!want && f.idle) return void (f.link.href = f.idle);
    const m = f.m;
    m.b.fill(0);
    m.set(want ?? 'eyes');
    // While it works the eyes stay faintly lit, like the robot in the app.
    const floor = want && ACTIVE.has(want) ? EYE_FLOOR : 0;
    // Skip the encode when the dots look the same as the last frame.
    let sig = '';
    const draw = () => {
      const next = Array.from(m.b, (v) => Math.round(Math.min(1, v) * 15).toString(16)).join('');
      if (next === sig) return;
      sig = next;
      drawFavicon(f.ctx, S, m, floor);
      f.link.href = f.cv.toDataURL('image/png');
    };
    const still = () => (m.still(), draw());
    if (!want || calm) return still();
    // A hidden tab keeps a still frame of the state instead of a timer.
    let timer = 0;
    let last = 0;
    const run = () => {
      clearInterval(timer);
      if (document.hidden) return still();
      last = performance.now();
      timer = window.setInterval(() => {
        const now = performance.now();
        m.update(Math.min(0.4, (now - last) / 1000));
        last = now;
        draw();
      }, FRAME);
    };
    run();
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [want, calm]);

  useEffect(() => () => {
    const f = fav.current;
    if (f?.idle) f.link.href = f.idle;
  }, []);
}
