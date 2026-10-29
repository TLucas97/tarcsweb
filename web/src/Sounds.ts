import { useEffect } from 'react';
import { getPref, usePref } from './prefs.ts';
import type { Sfx } from './soundEngine.ts';

// The sound engine downloads only while some sound is on, and Lite turns them all off.
export function useRobotSounds() {
  const hum = usePref('soundHum');
  const voice = usePref('soundVoice');
  const fx = usePref('soundFx');
  const on = hum || voice || fx;
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

// A one-shot effect; with effects off (Lite included) nothing loads.
export function sfx(kind: Sfx) {
  if (!getPref('soundFx')) return;
  void import('./soundEngine.ts').then((m) => m.oneShot(kind));
}

// A soft tick per word in guided reading and the lens; it follows the effects switch.
export function readTick(end: boolean) {
  if (!getPref('soundFx')) return;
  void import('./soundEngine.ts').then((m) => m.readTick(end));
}

// A spoken word, 1-based (hop-n.mp3); it follows the robot voice switch.
export function voice(n: number) {
  if (!getPref('soundVoice')) return;
  void import('./soundEngine.ts').then((m) => m.word(n));
}
