import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePref } from './prefs.ts';
import { reduceMotion } from './bits.tsx';

type Kind = 'plain' | 'act' | 'close';

// size px, start and end scale, start opacity, duration ms. Close rings shrink inward instead of growing.
const LOOK: Record<Kind, [size: number, from: number, to: number, alpha: number, ms: number]> = {
  plain: [26, 0.35, 1, 0.7, 420],
  act: [44, 0.3, 1, 0.95, 460],
  close: [36, 1.25, 0.5, 0.85, 400],
};
const MAX = 6;
const ACT = 'button,a[href],summary,label,select,input[type=checkbox],input[type=radio],input[type=range],[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=switch],[role=checkbox],[role=radio]';
const TEXT = 'textarea,input,[contenteditable=""],[contenteditable=true]';
const CLOSE = /^(close|dismiss|remove|delete|stop|cancel|discard)\b/i;

// The caret already answers a click in a text field, so those get no ring.
function kindOf(t: Element): Kind | null {
  const hit = t.closest(ACT) ?? (getComputedStyle(t).cursor === 'pointer' ? t : null);
  if (!hit) return t.closest(TEXT) ? null : 'plain';
  if (hit.matches(':disabled,[aria-disabled=true]')) return 'plain';
  // Only short visible text counts, so a row titled "Stop the deploy" is not a close button.
  const text = (hit.textContent ?? '').trim();
  const name = hit.getAttribute('aria-label') || hit.getAttribute('title') || (text.length <= 16 ? text : '');
  return CLOSE.test(name) ? 'close' : 'act';
}

// Off in Settings means nothing is mounted and no listener runs.
export function ClickRipple() {
  const on = usePref('clickRipple');
  return on ? createPortal(<Layer />, document.body) : null;
}

function Layer() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = host.current;
      if (!el || !e.isPrimary || e.button !== 0 || e.pointerType === 'touch' || !(e.target instanceof Element)) return;
      const kind = kindOf(e.target);
      if (!kind) return;
      if (el.childElementCount >= MAX) el.firstElementChild!.remove();
      const [size, from, to, alpha, ms] = LOOK[kind];
      const still = reduceMotion();
      const ring = document.createElement('i');
      ring.className = `ck-ring ${kind}`;
      ring.style.width = ring.style.height = `${size}px`;
      el.appendChild(ring);
      const at = `translate(${e.clientX - size / 2}px,${e.clientY - size / 2}px)`;
      const a = ring.animate(
        [{ transform: `${at} scale(${still ? 1 : from})`, opacity: alpha }, { transform: `${at} scale(${still ? 1 : to})`, opacity: 0 }],
        { duration: ms, easing: 'cubic-bezier(.23,1,.32,1)' },
      );
      a.onfinish = a.oncancel = () => ring.remove();
    };
    addEventListener('pointerdown', down, { capture: true, passive: true });
    return () => removeEventListener('pointerdown', down, { capture: true });
  }, []);

  return <div ref={host} className="ck-layer" aria-hidden="true"></div>;
}
