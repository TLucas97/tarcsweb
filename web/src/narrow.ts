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
// Under 900px: model, voice and usage fold behind the composer's ⋯ button.
const chips = tier('(max-width: 899px)');

export const isNarrow = narrow.is;
export const useNarrow = narrow.use;
export const isPills = pills.is;
export const usePills = pills.use;
export const useFoldChips = chips.use;
