import { useEffect, useRef, useState } from 'react';
import { reduceMotion } from './bits.tsx';
import { Robot } from './robot.tsx';
import { Flap } from './flap.tsx';

const KEY = 'cw:booted';
const NAME = 'tarcsweb';
const BLANK = ' '.repeat(NAME.length);
const NAME_HOPS: [number, number] = [2, 5];
const SIZE = 96;
// The boot starts dark: the prototype's first tenth powers the robot down, and here there is nothing to power down.
const FROM_DARK = 0.1;
// After the name starts flipping, how long the intro holds before it fades.
const HOLD_MS = 1050;
// If the robot never reports (a tab hidden mid-boot), the intro still leaves.
const MAX_MS = 4200;

function shouldBoot() {
  if (reduceMotion() || document.hidden || new URLSearchParams(location.search).has('embed')) return false;
  try {
    return !sessionStorage.getItem(KEY);
  } catch {
    return false;
  }
}

// Once per tab: the robot's power-on (segments drop in, self-test, eyes open), then the name flips in and it fades.
// A click or key skips it.
export function Boot() {
  const [on, setOn] = useState(shouldBoot);
  const [name, setName] = useState(BLANK);
  const root = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const leave = useRef<(ms: number) => void>(() => {});
  const fade = useRef(0);

  useEffect(() => {
    if (!on) return;
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      // Private modes can refuse storage; the intro just plays again.
    }
    let alive = true;
    let gone = false;
    leave.current = (ms: number) => {
      if (gone) return;
      gone = true;
      clearTimeout(fade.current);
      const el = root.current;
      if (!el) return;
      // Clicks pass through as soon as it starts to fade.
      el.style.pointerEvents = 'none';
      const ease = { duration: ms, easing: 'ease-out', fill: 'forwards' } as const;
      row.current?.animate([{ transform: 'none' }, { transform: 'scale(.98)' }], ease);
      el.animate([{ opacity: 1 }, { opacity: 0 }], ease).finished.then(() => alive && setOn(false), () => {});
    };
    fade.current = window.setTimeout(() => leave.current(220), MAX_MS);
    // Any click or key skips the intro, so it never stands between the user and the app.
    const skip = () => leave.current(120);
    addEventListener('pointerdown', skip, true);
    addEventListener('keydown', skip, true);
    return () => {
      alive = false;
      clearTimeout(fade.current);
      removeEventListener('pointerdown', skip, true);
      removeEventListener('keydown', skip, true);
    };
  }, [on]);

  // The self-test ends on the mark: the name starts flipping and the intro holds a moment longer.
  const onCue = (c: string) => {
    if (c !== 'mark') return;
    setName(NAME);
    clearTimeout(fade.current);
    fade.current = window.setTimeout(() => leave.current(220), HOLD_MS);
  };

  if (!on) return null;
  return (
    <div className="boot" ref={root} aria-hidden="true">
      <div className="boot-row" ref={row}>
        <Robot size={SIZE} state="boot" from={FROM_DARK} lead onCue={onCue} />
        <span className="boot-name"><Flap tiles text={name} hops={NAME_HOPS} /></span>
      </div>
    </div>
  );
}
