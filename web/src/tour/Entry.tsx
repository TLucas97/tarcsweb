import { Suspense, lazy, useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { isReady, useSetup } from '../setup.ts';
import { useLayoutVars } from '../layoutVars.ts';
import { ESSENTIALS } from './chapters.ts';
import { markSeen, playTour, unseen, useTourPlay, useTourSeen } from './state.ts';

const Player = lazy(() => import('./Player.tsx'));

export const TourIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="7" cy="7" r="5.2" />
    <path d="M5.9 4.9v4.2L9.3 7z" fill="currentColor" stroke="none" />
  </svg>
);

// Waits out the boot intro, so the invite never lands on top of it.
function useAfterBoot() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let t = 0;
    const check = () => {
      t = document.querySelector('.boot') ? window.setTimeout(check, 400) : window.setTimeout(() => setOk(true), 600);
    };
    check();
    return () => clearTimeout(t);
  }, []);
  return ok;
}

// First open asks once; after an update with new chapters, a smaller note offers just those.
function Invite() {
  const seen = useTourSeen();
  const onStart = useStore((s) => !s.current);
  const ready = useSetup(isReady);
  const settled = useAfterBoot();
  // Sits right above the composer, whatever its height.
  const ref = useLayoutVars<HTMLDivElement>();
  if (!ready || !onStart || !settled) return null;
  const fresh = seen ? unseen(seen) : null;
  if (fresh && !fresh.length) return null;
  return (
    <div className="tour-ask" ref={ref} role="dialog" aria-labelledby="tour-ask-t" aria-describedby="tour-ask-d">
      <span className="tour-ask-i"><TourIcon /></span>
      <div className="tour-ask-tx">
        <b id="tour-ask-t">{fresh ? 'New in the tour' : 'Take a quick tour?'}</b>
        <p id="tour-ask-d">
          {fresh
            ? fresh.map((c) => c.title).join(', ')
            : `${ESSENTIALS.length} short clips on what you can do here. You can replay them any time in Settings > Tour.`}
        </p>
        <div className="tour-ask-row">
          <button type="button" className="set-btn" onClick={() => playTour(fresh ?? undefined)}>{fresh ? 'Watch' : 'Start tour'}</button>
          <button type="button" className="tour-ghost" onClick={markSeen}>{fresh ? 'Dismiss' : 'Not now'}</button>
        </div>
      </div>
    </div>
  );
}

export function TourMount() {
  const play = useTourPlay();
  return (
    <>
      <Invite />
      {play && <Suspense fallback={null}><Player play={play} /></Suspense>}
    </>
  );
}
