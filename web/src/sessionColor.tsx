import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DockState } from '../../server/protocol.ts';
import { Glyph, pref } from './bits.tsx';
import type { LedPattern } from './led.tsx';
import { heavy } from './perf.ts';
import { useStore } from './store.ts';

// Muted robot colours: no amber (needs you), green (done) or red (errors), so the LEDs keep the state.
export const PALETTE = [
  { hex: '#5d7fae', name: 'Blue' },
  { hex: '#8a75c0', name: 'Violet' },
  { hex: '#b0709f', name: 'Rose' },
  { hex: '#4f9aa8', name: 'Teal' },
  { hex: '#7c8496', name: 'Slate' },
  { hex: '#6a6fd0', name: 'Indigo' },
] as const;

// Session id to palette index, oldest first. Closed sessions drop out; the cap covers anything missed.
const KEY = 'dock.colors';
const MAX = 64;
const subs = new Set<() => void>();
const read = (): Record<string, number> => {
  const v = pref.get<unknown>(KEY, {});
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(Object.entries(v).filter(([, i]) => Number.isInteger(i) && i >= 0 && i < PALETTE.length)) as Record<string, number>;
};
let colors = read();

function save(next: Record<string, number>) {
  const keys = Object.keys(next);
  colors = keys.length > MAX ? Object.fromEntries(keys.slice(-MAX).map((k) => [k, next[k]])) : next;
  pref.set(KEY, colors);
  for (const fn of subs) fn();
}

export function setColor(id: string, i: number) {
  if (colors[id] === i) return;
  const next = { ...colors };
  delete next[id];
  next[id] = i;
  save(next);
}

// New sessions take the colour fewest open sessions use; closed ones give theirs back.
function sync(ids: string[], prev: string[]) {
  const open = new Set(ids);
  const next = { ...colors };
  let changed = false;
  for (const id of prev) if (!open.has(id) && id in next) (delete next[id], (changed = true));
  const used = PALETTE.map(() => 0);
  for (const id of ids) if (id in next) used[next[id]]++;
  for (const id of ids) {
    if (id in next) continue;
    const i = used.indexOf(Math.min(...used));
    used[i]++;
    next[id] = i;
    changed = true;
  }
  if (changed) save(next);
}

sync(useStore.getState().roster.map((r) => r.id), []);
const unsub = useStore.subscribe((s, p) => {
  if (s.roster !== p.roster) sync(s.roster.map((r) => r.id), p.roster.map((r) => r.id));
});

const onStorage = (e: StorageEvent) => {
  if (e.key !== `cw:${KEY}`) return;
  colors = read();
  for (const fn of subs) fn();
};
addEventListener('storage', onStorage);
import.meta.hot?.dispose(() => {
  unsub();
  removeEventListener('storage', onStorage);
});

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const useSessionColor = (id: string) => useSyncExternalStore(subscribe, () => colors[id] ?? 0);

type TileProps = { id: string; state: DockState; needsYou?: boolean; background?: boolean; pattern?: LedPattern };

// A session's robot with its body in the session colour. The amber corner dot repeats "needs you" without motion.
export function SessionTile({ id, state, needsYou, background, pattern }: TileProps) {
  const c = PALETTE[useSessionColor(id)].hex;
  const need = needsYou || state === 'waiting';
  return (
    <span className={`stile${need ? ' need' : ''}`} style={{ '--c': c } as React.CSSProperties}>
      <Glyph state={state} background={background} pattern={pattern} tile={false} color={c} />
    </span>
  );
}

export const ColorDot = ({ id }: { id: string }) => <i className="cdot" style={{ '--c': PALETTE[useSessionColor(id)].hex } as React.CSSProperties} />;

// The colour picker for one session; the picked swatch blinks once, then the caller closes.
export function Swatches({ id, onDone }: { id: string; onDone: () => void }) {
  const cur = useSessionColor(id);
  const [blink, setBlink] = useState<number | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pick = (i: number) => {
    if (heavy()) {
      setColor(id, i);
      return onDone();
    }
    setBlink(i);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setBlink(null);
      setColor(id, i);
      onDone();
    }, 100);
  };
  return (
    <div className="swatches" role="group" aria-label="Robot colour">
      <span className="sw-t">Robot colour</span>
      {PALETTE.map((p, i) => (
        <button
          key={p.hex} type="button" className={`swc${blink === i ? ' blink' : ''}`} style={{ '--c': p.hex } as React.CSSProperties}
          role="menuitemradio" aria-checked={i === cur} aria-label={p.name} title={p.name} onClick={() => pick(i)}
        />
      ))}
    </div>
  );
}
