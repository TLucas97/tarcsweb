import { flushSync } from 'react-dom';
import { reduceMotion } from '../bits.tsx';
import { releaseFollow } from '../InlineRead.tsx';
import { setOpen } from './store.ts';

const EASE = 'cubic-bezier(.23,1,.32,1)';
const FLIP_ID = 'st-flip';
// How many elements below the stretch slide into place; the rest are off screen.
const FLIP_MAX = 24;
// The conversation's top fade is 72px tall.
const TOP_CLEAR = 80;

// Everything below the paragraph that holds el, in this message and the rows after it, while on screen.
function below(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const bottom = innerHeight;
  const walk = (from: Element | null) => {
    for (let n = from; n && out.length < FLIP_MAX; n = n.nextElementSibling) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.getBoundingClientRect().top > bottom) return false;
      out.push(n);
    }
    return true;
  };
  const block = el.closest<HTMLElement>('.say > *');
  const say = block?.parentElement;
  if (!block || !say) return out;
  if (walk(block.nextElementSibling) && walk(say.nextElementSibling)) walk(say.closest('.reply')?.nextElementSibling ?? null);
  return out;
}

// Opens or closes a stretch in place: words already read keep their place, what sits below slides to its new spot (FLIP) and the added words fade in.
export function toggleStretch(btn: HTMLElement, msg: string, key: string, id: string, open: boolean, byKeyboard: boolean) {
  const root = btn.closest<HTMLElement>('.say');
  const still = reduceMotion();
  const moved = still ? [] : below(btn);
  const first = moved.map((el) => el.getBoundingClientRect().top);
  for (const el of moved) for (const a of el.getAnimations()) if (a.id === FLIP_ID) a.cancel();
  // Reading in place: the conversation must not jump to the bottom as the reply grows.
  releaseFollow();
  flushSync(() => setOpen(msg, key, open));
  if (!root?.isConnected) return;
  moved.forEach((el, i) => {
    if (!el.isConnected) return;
    const dy = first[i] - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    const a = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: open ? 260 : 200, easing: EASE });
    a.id = FLIP_ID;
  });
  if (open && !still) {
    const added = root.querySelectorAll<HTMLElement>(`.st-new[data-st="${id}"]`);
    added.forEach((el, i) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay: Math.min(i * 35, 140), easing: EASE, fill: 'backwards' }));
    root.querySelector<HTMLElement>(`[data-st-c="${id}"]`)?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 120, easing: EASE, fill: 'backwards' });
  }
  // The clicked short form is gone once open; the long form's close mark sits in the same paragraph.
  const mark = open ? root.querySelector<HTMLElement>(`[data-st-c="${id}"]`) : null;
  if (mark) bringIntoView(mark);
  if (byKeyboard) root.querySelector<HTMLElement>(open ? `[data-st-c="${id}"]` : `[data-st-o="${id}"]`)?.focus({ preventScroll: true });
}

// Brings the opened paragraph to the top of the view (clear of the faded edge), so it and what follows it can be read.
function bringIntoView(el: HTMLElement) {
  const block = el.closest<HTMLElement>('.say > *');
  const conv = el.closest<HTMLElement>('.conv');
  if (!block || !conv) return;
  const top = block.getBoundingClientRect().top - conv.getBoundingClientRect().top - TOP_CLEAR;
  if (top > 0) conv.scrollBy({ top, behavior: reduceMotion() ? 'auto' : 'smooth' });
}
