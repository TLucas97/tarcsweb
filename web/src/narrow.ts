import { useSyncExternalStore } from 'react';

// Width tiers; each matches a media query in styles.css ("narrow windows", "middle widths").
function tier(query: string) {
  const mql = matchMedia(query);
  const subscribe = (fn: () => void) => {
    mql.addEventListener('change', fn);
    return () => mql.removeEventListener('change', fn);
  };
  const is = () => mql.matches;
  return { is, use: () => useSyncExternalStore(subscribe, is) };
}

// Under 720px: the dock keeps one tab plus the Sessions sheet, renderers fit the column.
const narrow = tier('(max-width: 719px)');
// Under 1024px: Work and Agents fold into the joined pill group and open as sheets.
const pills = tier('(max-width: 1023px)');

export const isNarrow = narrow.is;
export const useNarrow = narrow.use;
export const isPills = pills.is;
export const usePills = pills.use;

// The composer toolbar goes tight (styles.css, .input[data-tight]) when the relaxed one squeezes Send or overflows; the
// attribute keeps the width it needed, and it relaxes once the box has it. True when it just went tight.
export function fitTools(form: HTMLElement) {
  const send = form.querySelector<HTMLElement>('.send');
  const tools = form.querySelector<HTMLElement>('.tools');
  if (!send || !tools) return false;
  const cs = getComputedStyle(form);
  const room = form.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const was = form.dataset.tight;
  if (was !== undefined) {
    if (room < Number(was)) return false;
    delete form.dataset.tight;
  }
  const short = send.offsetHeight - send.offsetWidth + Math.max(0, tools.scrollWidth - tools.clientWidth);
  if (short > 0) form.dataset.tight = String(Math.ceil(room + short));
  return short > 0 && was === undefined;
}
