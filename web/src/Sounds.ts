import { useEffect } from 'react';
import { usePref } from './prefs.ts';

// The sound engine downloads only while sounds are on, and Lite turns them off.
export function useRobotSounds() {
  const on = usePref('sounds');
  useEffect(() => {
    if (!on) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void import('./soundEngine.ts').then((m) => {
      if (!gone) stop = m.start();
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [on]);
}
