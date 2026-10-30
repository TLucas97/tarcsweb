import { useCallback, type RefObject } from 'react';

// Composer (--ch) and heads-up (--hh) heights and the large sidebar's width (--dw), set only on the fixed elements that
// read them. On :root every change restyled the whole page; styles.css registers them as non-inherited.
type Name = '--ch' | '--hh' | '--dw';
const vars: Partial<Record<Name, string>> = {};
const els = new Set<HTMLElement>();

export function setLayoutVar(name: Name, value: string | null) {
  if ((vars[name] ?? null) === value) return;
  if (value === null) delete vars[name];
  else vars[name] = value;
  for (const el of els) value === null ? el.style.removeProperty(name) : el.style.setProperty(name, value);
}

function bind(el: HTMLElement) {
  els.add(el);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  return () => void els.delete(el);
}

// Ref callback for an element whose CSS reads --ch or --hh; pass the component's own ref to keep it filled.
export function useLayoutVars<T extends HTMLElement>(ref?: RefObject<T | null>) {
  return useCallback(
    (el: T | null) => {
      if (ref) ref.current = el;
      if (!el) return;
      const off = bind(el);
      return () => {
        if (ref) ref.current = null;
        off();
      };
    },
    [ref],
  );
}
