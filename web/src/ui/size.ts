import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

type Sub = (w: number) => void;

// One ResizeObserver for every width-driven drawing; several drawings may watch the same host.
const subs = new WeakMap<Element, Set<Sub>>();
let ro: ResizeObserver | null = null;

// Layout is clean inside the callback: read every width first, then render all updates at once,
// synchronously, so the first paint already has the sized drawings.
function onResize(entries: ResizeObserverEntry[]) {
  const ups: [Set<Sub>, number][] = [];
  for (const e of entries) {
    const s = subs.get(e.target);
    if (s) ups.push([s, (e.target as HTMLElement).clientWidth]);
  }
  if (ups.length) flushSync(() => ups.forEach(([s, w]) => s.forEach((set) => set(w))));
}

function observeWidth(el: Element, set: Sub) {
  ro ??= new ResizeObserver(onResize);
  let s = subs.get(el);
  if (!s) {
    subs.set(el, (s = new Set()));
    ro.observe(el);
  }
  s.add(set);
  return () => {
    s.delete(set);
    if (s.size) return;
    subs.delete(el);
    ro?.unobserve(el);
  };
}

// Client width of the ref'd element, or of the host `pick` returns; 0 until the observer reports.
export function useWidth<E extends Element = HTMLDivElement>(pick?: (el: E) => Element | null | undefined) {
  const ref = useRef<E>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current!;
    // The host is fixed for the element's life.
    return observeWidth((pick && pick(el)) || el, setW);
  }, []);
  return [ref, w] as const;
}
