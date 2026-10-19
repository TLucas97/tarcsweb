import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { DockState } from '../../server/protocol.ts';
import { Led, type LedPattern } from './led.tsx';
import { Robot } from './robot.tsx';
import { afterFrames, reach, release, showRow } from './convWindow.ts';
import { pushEscape } from './escape.ts';
import { useStore } from './store.ts';
import { reduceMotion } from './perf.ts';

// Date.now() refreshed every `ms` while `on`; paused while the tab is hidden, so an idle page costs nothing.
export function useTicker(on: boolean, ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!on) return;
    let t = 0;
    const run = () => {
      clearInterval(t);
      if (document.hidden) return;
      setNow(Date.now());
      t = window.setInterval(() => setNow(Date.now()), ms);
    };
    run();
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', run);
    };
  }, [on, ms]);
  return now;
}

// Per-browser UI preferences; storage can be blocked, so reads fall back and writes may no-op.
export const pref = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`cw:${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`cw:${key}`, JSON.stringify(value));
    } catch {}
  },
};

export { reduceMotion };

// For top-layer dialogs: nothing behind them is inert, so Tab wraps inside by hand.
export function trapTab(e: ReactKeyboardEvent<HTMLElement>) {
  const els = [...e.currentTarget.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]')]
    .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.checkVisibility());
  if (!els.length) return;
  const i = els.indexOf(document.activeElement as HTMLElement);
  const to = e.shiftKey ? (i <= 0 ? els.at(-1) : null) : i === els.length - 1 ? els[0] : null;
  if (!to) return;
  e.preventDefault();
  to.focus();
}

// bump-motion: surfaces open in 300ms FastOutSlowIn and settle back on a critical spring (k 1500) sampled into linear().
export const FOSI = 'cubic-bezier(.4,0,.2,1)';
export function springEasing(k: number) {
  const w = Math.sqrt(k);
  const x = (t: number) => 1 - (1 + w * t) * Math.exp(-w * t);
  let end = 0;
  for (let t = 0; t < 2; t += 0.001) if (1 - x(t) > 0.001) end = t;
  const n = Math.ceil(end * 60);
  return { easing: `linear(${Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : +x((i / n) * end).toFixed(4))).join(',')})`, ms: Math.round(end * 1000) };
}
export const SPRING = springEasing(1500);

// Morphs a fixed box from its old rect to where it now sits; the content hides while the box moves, so the new layout never stretches.
export function morphBox(el: HTMLElement, from: DOMRect, opening: boolean) {
  if (reduceMotion()) return;
  // CSS width transitions would start on the class change and make the measured end size the old one.
  el.style.transition = 'none';
  const to = el.getBoundingClientRect();
  const box = (b: DOMRect) => ({ top: `${b.top}px`, left: `${b.left}px`, width: `${b.width}px`, height: `${b.height}px`, right: 'auto', bottom: 'auto', margin: '0' });
  const inner = [...el.children] as HTMLElement[];
  const run = opening
    ? el.animate([box(from), box(to)], { duration: 300, easing: FOSI })
    : el.animate([box(from), box(to)], { duration: SPRING.ms, easing: SPRING.easing });
  if (opening) inner.forEach((c) => c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 90, easing: FOSI, fill: 'backwards' }));
  else inner.forEach((c) => c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: SPRING.ms - 60, easing: FOSI, fill: 'backwards' }));
  run.finished.then(() => (el.style.transition = ''), () => (el.style.transition = ''));
}

// Esc leaves a fullscreen view first (the newest one); open popovers and dialogs keep their own Esc.
export function useEscape(on: boolean, fn: () => void) {
  const run = useEffectEvent(fn);
  useEffect(() => {
    if (!on) return;
    return pushEscape(() => run());
  }, [on]);
}

export const ExpandIcon = ({ out }: { out: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d={out ? 'M4.5 1v3.5H1M7.5 1v3.5H11M4.5 11V7.5H1M7.5 11V7.5H11' : 'M1 4.5V1h3.5M11 4.5V1H7.5M1 7.5V11h3.5M11 7.5V11H7.5'} />
  </svg>
);

// Scrolls a conversation node into view and flashes it, mounting its row first. An item in history not loaded yet
// loads first; false when it is in neither.
export function goTo(id: string): boolean {
  if (!useStore.getState().items[id] && !useStore.getState().items[`perm:${id}`]) {
    void reach(id).then((ok) => ok && goTo(id));
    return useStore.getState().older !== null;
  }
  const sel = `.col [data-id="${CSS.escape(id)}"]`;
  const mounted = !!document.querySelector(sel);
  showRow(id);
  const el = document.querySelector<HTMLElement>(sel);
  const conv = el?.closest('.conv');
  if (!el || !conv) return false;
  const far = !mounted || Math.abs(el.getBoundingClientRect().top - conv.getBoundingClientRect().top) > conv.clientHeight * 2;
  if (!far) el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  else {
    // Far rows sit among rows that change height as they render: jump once they are placed, then again after they render.
    // Mounting can scroll the view back to the bottom, which re-pins it there, so each jump lets go first.
    const center = () => {
      release();
      if (el.isConnected) el.scrollIntoView({ block: 'center' });
    };
    afterFrames(() => (center(), afterFrames(center)));
  }
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  return true;
}

// A block the model is still writing: calm, since the working line plays the live pattern.
export const Pending = ({ text }: { text: string }) => <span className="pend"><Led size="sm" pattern="calm" />{text}</span>;

// Small robots in rows and tabs: the mark-small grid lands on whole pixels at 16.
export const GLYPH = 16;
// The idle robot that greets an empty screen.
export const HERO = 112;

// The small robot of a session. `pattern` is the current session's activity; other sessions do not send theirs, so they think.
export function Glyph({ state, pattern, background }: { state: DockState; pattern?: LedPattern; background?: boolean }) {
  if (state === 'working' || state === 'waiting') {
    return <span className="g gled"><Robot size={GLYPH} state={state === 'waiting' ? 'needs' : pattern ?? 'think'} /></span>;
  }
  // The main thread is idle but subagents still run (the roster's flag ignores processes).
  if (background) return <span className="g gled" title="Agents running in the background"><Robot size={GLYPH} state="delegating" /></span>;
  return <span className={`g dot${state === 'done' ? ' d' : ''}`}></span>;
}

export const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><rect x="3.8" y="3.8" width="6.4" height="6.4" rx="1.4" /><path d="M8.2 2.6V2.4c0-.6-.4-1-1-1H2.8c-.6 0-1 .4-1 1v4.4c0 .6.4 1 1 1H3" /></svg>
);

// Copies on click and says so in place for a moment. text may be read at click time.
export function CopyBtn({ text, what = 'message', label = true }: { text: string | (() => string); what?: string; label?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  const copy = () =>
    navigator.clipboard?.writeText(typeof text === 'function' ? text() : text).then(() => {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1400);
    });
  return (
    <button type="button" className={`cpb${done ? ' done' : ''}`} aria-label={done ? 'Copied' : `Copy ${what}`} title={`Copy ${what}`} onClick={copy}>
      {done ? <Check /> : <CopyIcon />}
      {label && <span>{done ? 'Copied' : 'Copy'}</span>}
    </button>
  );
}

export const Chev = () => (
  <svg className="chev" width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 6.2 5 3.7l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const BranchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--muted)" strokeWidth="1.3" strokeLinecap="round"><circle cx="3" cy="2.5" r="1.3" /><circle cx="3" cy="9.5" r="1.3" /><circle cx="9" cy="4" r="1.3" /><path d="M3 3.8v4.4M9 5.3c0 2-6 1.5-6 3" /></svg>
);

// "12m", "3h", "yesterday", "Oct 8", like the mockup's palette.
export function ago(ms: number) {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const then = new Date(ms);
  const today = new Date();
  if (then.toDateString() === today.toDateString()) return `${Math.floor(min / 60)}h`;
  today.setDate(today.getDate() - 1);
  if (then.toDateString() === today.toDateString()) return 'yesterday';
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function tilde(path: string, home: string) {
  return home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
}

export const baseName = (path: string) => path.split('/').filter(Boolean).pop() || 'home';

// Marks a session that runs on Codex; Claude, the default, gets none.
export const CodexTag = () => <span className="prov" title="Runs on Codex">Codex</span>;

const icon = (d: string, size = 14) => () => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const XIcon = icon('M4 4l6 6M10 4l-6 6');
export const AgentsIcon = icon('M5 6.2a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM1.8 11.5c.4-1.9 1.6-3 3.2-3s2.8 1.1 3.2 3M9.4 6.2a1.7 1.7 0 1 0 0-3.4M10.4 8.7c1 .4 1.6 1.3 1.8 2.8');
export const WorkIcon = icon('M2 3.6l1 1 1.7-1.9M6.6 4h5.4M2 8.6l1 1 1.7-1.9M6.6 9h5.4');
export const PencilIcon = icon('M9.2 2.8l2 2L5 11H3v-2zM8 4l2 2');
export const ArchiveIcon = icon('M2 3h10v2.5H2zM3 5.5V11h8V5.5M5.8 7.8h2.4');
export const UnarchiveIcon = icon('M2 3h10v2.5H2zM3 5.5V11h8V5.5M7 10V7M5.6 8.3 7 6.9l1.4 1.4');
export const TrashIcon = icon('M2.5 4h9M5.5 4V2.6h3V4M3.8 4l.6 7.4h5.2l.6-7.4');
export const HomeIcon = icon('M2 6.4 7 2.2l5 4.2M3.4 5.3v6.2h7.2V5.3M5.8 11.5V8.4h2.4v3.1');
export const ChevRight = icon('M5.5 3l4 4-4 4');
export const ChevLeft = icon('M8.5 3l-4 4 4 4');

// Two-step confirm: the first press arms an id for a few seconds, a second press on it returns true.
export function useArm(ms = 3000) {
  const [armed, setArmed] = useState<string | null>(null);
  const ref = useRef({ id: null as string | null, timer: 0 });
  useEffect(() => () => clearTimeout(ref.current.timer), []);
  const press = (id: string) => {
    const r = ref.current;
    clearTimeout(r.timer);
    if (r.id === id) {
      r.id = null;
      setArmed(null);
      return true;
    }
    r.id = id;
    setArmed(id);
    r.timer = window.setTimeout(() => {
      r.id = null;
      setArmed(null);
    }, ms);
    return false;
  };
  return [armed, press] as const;
}

// Inline name editor: Enter or blur saves, Esc cancels; onDone gets null when nothing changed.
export function RenameInput({ value, className, onDone }: { value: string; className?: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current!.focus();
    ref.current!.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current!.value.trim();
    onDone(save && v && v !== value ? v : null);
  };
  return (
    <input
      ref={ref} className={className} defaultValue={value} aria-label="Session name" maxLength={80} spellCheck={false} autoComplete="off"
      onKeyDown={(e) => {
        // Keeps Esc from stopping a turn or closing the palette.
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          finish(e.key === 'Enter');
        }
      }}
      onBlur={() => finish(true)} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
    />
  );
}
