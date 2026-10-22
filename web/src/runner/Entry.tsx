import { Suspense, lazy, useEffect, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useLite } from '../perf.ts';
import { ChunkGuard } from '../Stale.tsx';
import { setRunner, useRunning } from './open.ts';

// The game and its code load on the first Start.
const Runner = lazy(() => import('./Runner.tsx'));

// The egg's invitation over the strip robot. A native popover: an outside click or Esc closes it.
export function EggPop({ ref }: { ref: Ref<HTMLDivElement> }) {
  const start = (el: HTMLElement) => {
    el.closest<HTMLElement>('[popover]')?.hidePopover();
    setRunner(true);
  };
  return (
    <div ref={ref} className="rn-egg" popover="auto" role="dialog" aria-label="A hidden game">
      <span className="rn-say mono">me. run. away!!!</span>
      <button type="button" className="rn-go" onClick={(e) => start(e.currentTarget)}>Start</button>
    </div>
  );
}

// Mounted once in App; renders nothing until Start. Lite has no self-running loops, so switching it on ends the game.
export function RunnerMount() {
  const on = useRunning();
  const lite = useLite();
  useEffect(() => {
    if (on && lite) setRunner(false);
  }, [on, lite]);
  if (!on || lite) return null;
  return createPortal(<ChunkGuard><Suspense fallback={null}><Runner /></Suspense></ChunkGuard>, document.body);
}
