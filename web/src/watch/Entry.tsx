import { Suspense, lazy, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store.ts';
import { setWatch, useWatching } from './open.ts';
import { useLite } from '../perf.ts';

// The full-screen view and its code load on the first open.
const Watch = lazy(() => import('./Watch.tsx'));

// The robot's 3x3 panel as an icon: watch him work.
export const WatchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
    {[3, 7, 11].flatMap((y) => [3, 7, 11].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r={x === 7 && y === 7 ? 0.9 : 1.35} opacity={y === 7 && x !== 7 ? 1 : 0.55} />))}
  </svg>
);

// Lite has no watch mode: it is a full-screen animated scene.
export function WatchTrigger() {
  const on = useWatching();
  const lite = useLite();
  if (lite) return null;
  return (
    <button type="button" className="fnd-open" title="Watch" aria-label="Watch the session" aria-pressed={on} onClick={(e) => setWatch(true, e.currentTarget)}>
      <WatchIcon />
    </button>
  );
}

// Mounted once in App; renders nothing until watch opens. A session switch or close ends it.
export function WatchMount() {
  const on = useWatching();
  const sid = useStore((s) => s.current);
  const lite = useLite();
  // setWatch(false) also clears the timeline hand-off and the event stamps.
  useEffect(() => {
    if (on && (!sid || lite)) setWatch(false);
  }, [on, sid, lite]);
  if (!on || !sid || lite) return null;
  return createPortal(<Suspense fallback={null}><Watch key={sid} /></Suspense>, document.body);
}
