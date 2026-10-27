import { useEffect, useRef } from 'react';
import { useStore } from './store.ts';
import { usePref, useSavedPref } from './prefs.ts';
import { reduceMotion, useLite } from './perf.ts';
import { useWatching } from './watch/open.ts';

const CELL = 32;
const LAMP = 360;
const MAX_PULSES = 4;

// Distance from v back to the grid line at or before it.
const off = (v: number) => ((v % CELL) + CELL) % CELL;

// Off in Settings means the grid is not mounted at all: no timers, no pointer listener. Watch covers it, so it rests then too.
export function Backdrop() {
  const on = usePref('backdrop');
  const saved = useSavedPref('backdrop');
  const lite = useLite();
  const watching = useWatching();
  if (watching) return null;
  if (on) return <Grid />;
  // Lite reads the pref as off but keeps a chosen grid as one static layer: no lamp, timers or listeners.
  return lite && saved ? <div className="bd" aria-hidden="true" /> : null;
}

// Faint grid behind the app: light runs along the lines and the area under the mouse lights up.
function Grid() {
  const root = useRef<HTMLDivElement>(null);
  const lamp = useRef<HTMLDivElement>(null);
  const lit = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let x = 0, y = 0, tx = 0, ty = 0, on = 0, ton = 0, raf = 0;

    // The lamp eases toward the pointer; the loop stops once it settles, so a still mouse costs nothing.
    const frame = () => {
      const still = reduceMotion();
      const k = still ? 1 : 0.2;
      x += (tx - x) * k;
      y += (ty - y) * k;
      on += (ton - on) * (still ? 1 : 0.1);
      const lx = x - LAMP / 2;
      const ly = y - LAMP / 2;
      const busy = Math.abs(tx - x) + Math.abs(ty - y) > 0.3 || Math.abs(ton - on) > 0.005;
      const l = lamp.current!;
      l.style.transform = `translate(${lx}px,${ly}px)`;
      // The lit grid is one cell larger than the lamp and shifts by the remainder, so its lines stay on the page grid.
      lit.current!.style.transform = `translate(${-off(lx)}px,${-off(ly)}px)`;
      l.style.opacity = on.toFixed(3);
      l.style.willChange = busy ? 'transform,opacity' : '';
      raf = busy ? requestAnimationFrame(frame) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      tx = e.clientX;
      ty = e.clientY;
      // Coming back from dark: appear at the pointer instead of gliding in from the old spot.
      if (on < 0.02) (x = tx), (y = ty);
      ton = 1;
      kick();
    };
    const leave = () => {
      ton = 0;
      kick();
    };

    // One short run of light along a random grid line, on the compositor.
    let live = 0;
    const pulse = () => {
      const host = root.current;
      if (!host || live >= MAX_PULSES) return;
      const across = Math.random() < 0.5;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const dist = CELL * (5 + Math.floor(Math.random() * 10));
      const el = document.createElement('i');
      el.className = `bd-p${across ? '' : ' v'}`;
      el.style.left = `${CELL * Math.floor((Math.random() * innerWidth) / CELL) - (across ? 24 : 0)}px`;
      el.style.top = `${CELL * Math.floor((Math.random() * innerHeight) / CELL) - (across ? 0 : 24)}px`;
      host.appendChild(el);
      live++;
      const to = across ? `translateX(${dir * dist}px) scaleX(${dir})` : `translateY(${dir * dist}px) scaleY(${dir})`;
      const from = across ? `translateX(0) scaleX(${dir})` : `translateY(0) scaleY(${dir})`;
      el.animate(
        [{ transform: from, opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.75 }, { transform: to, opacity: 0 }],
        { duration: dist * 9, easing: 'cubic-bezier(.45,0,.55,1)' },
      ).onfinish = () => {
        el.remove();
        live--;
      };
    };
    // Rests while the tab is hidden or unfocused and while a reply streams.
    const quiet = () => document.hidden || !document.hasFocus() || reduceMotion() || useStore.getState().status === 'working';
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (!quiet()) pulse();
        schedule();
      }, 500 + Math.random() * 1400);
    };
    schedule();

    addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    addEventListener('blur', leave);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
      removeEventListener('blur', leave);
    };
  }, []);

  return (
    <div className="bd" ref={root} aria-hidden="true">
      <div className="bd-lamp" ref={lamp}>
        <div className="bd-lit" ref={lit}></div>
      </div>
    </div>
  );
}
