import { useLayoutEffect, type RefObject } from 'react';

// Firefox and older Safari lack `field-sizing: content`; the CSS max-height still caps the JS height.
const native = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');

export function grow(el: HTMLTextAreaElement) {
  if (native) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

const onInput = (e: Event) => grow(e.currentTarget as HTMLTextAreaElement);

// Callback ref for a textarea that only changes by typing.
export const autosizeRef = (el: HTMLTextAreaElement | null) => {
  if (!el || native) return;
  grow(el);
  el.addEventListener('input', onInput);
  return () => el.removeEventListener('input', onInput);
};

// Also regrows when `dep` changes, for values set from code (a cleared draft, a restored one).
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, dep?: unknown) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || native) return;
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, [ref]);
  useLayoutEffect(() => {
    if (ref.current) grow(ref.current);
  }, [ref, dep]);
}
