import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { create } from 'zustand';
import { useStore } from './store.ts';
import { reduceMotion } from './bits.tsx';
import { ChunkGuard } from './Stale.tsx';
import type { ReadSource } from './Reader.tsx';
import type { DiffSource } from './DiffViewer.tsx';

// The reader, diff viewer and log body load on first use (or on idle), so the buttons here stay in the main chunk.
export const loadFocusBody = () => import('./FocusBody.tsx');
const FocusBody = lazy(loadFocusBody);
// FocusBody hands this in when it loads; a log view only exists once it has.
let logClose: (() => void) | null = null;
export const setLogClose = (fn: () => void) => void (logClose = fn);

// The fullscreen focus view. Frames stay where React put them and are promoted to the top layer
// (popover="manual"), so live iframes never reload; text and logs render a fresh copy in the stage.
export type View =
  | { mode: 'el'; label: string } | { mode: 'text'; label: string; source: ReadSource } | { mode: 'log'; label: string }
  | { mode: 'diff'; label: string; diff: DiffSource }
  // A body another module owns (the file tree); key tells which one is up.
  | { mode: 'panel'; label: string; key: string; body: ReactNode; foot?: string };
export const useFocus = create<{ view: View | null }>(() => ({ view: null }));

const FOSI = 'cubic-bezier(.4,0,.2,1)';
const ROUND = 'inset(0 round 16px)';

// Critical spring (k 1500) sampled into linear(), the bump-motion close.
let spring: { easing: string; ms: number } | null = null;
function springEasing() {
  if (spring) return spring;
  const w = Math.sqrt(1500);
  const x = (t: number) => 1 - (1 + w * t) * Math.exp(-w * t);
  let end = 0;
  for (let t = 0; t < 2; t += 0.001) if (1 - x(t) > 0.001) end = t;
  const n = Math.ceil(end * 60);
  const pts = Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : +x((i / n) * end).toFixed(4)));
  spring = { easing: `linear(${pts.join(',')})`, ms: Math.round(end * 1000) };
  return spring;
}

type Live = {
  mode: View['mode'];
  // Where the view closes back into; null when it left the screen.
  target: () => Element | null;
  el?: { node: HTMLElement; ph: HTMLElement; w: number; L: number; T: number; z: number; ro: ResizeObserver };
  anims: Animation[];
  back: Element | null;
  // Hands an edited paste back to its owner; runs once, before the view goes away.
  save?: () => void;
};
let fx: Live | null = null;
let closing = false;
let surface: HTMLElement | null = null;

const chrome = () => [...surface!.querySelectorAll<HTMLElement>('.fx-top,.rd-prog,.fx-foot')];
function clipAt(r: DOMRect, rad = 12) {
  const d = surface!.getBoundingClientRect();
  return `inset(${r.top - d.top}px ${d.right - r.right}px ${d.bottom - r.bottom}px ${r.left - d.left}px round ${rad}px)`;
}
// Transform that lays the promoted element (origin 0 0 at L,T, unscaled width w) over rect r.
const over = (e: NonNullable<Live['el']>, r: DOMRect) => `translate(${r.left - e.L}px,${r.top - e.T}px) scale(${r.width / e.w})`;

function show(view: View, from: DOMRect, live: Omit<Live, 'anims' | 'back' | 'mode'>) {
  fx = { mode: view.mode, anims: [], back: document.activeElement, ...live };
  flushSync(() => useFocus.setState({ view }));
  surface!.showPopover();
  if (fx.el) promote(fx.el);
  const editor = surface!.querySelector<HTMLTextAreaElement>('.rd-edit');
  if (editor) {
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    editor.scrollTop = editor.scrollHeight;
  } else if (view.mode !== 'el') surface!.querySelector<HTMLElement>('.fx-stage')?.focus({ preventScroll: true });
  else surface!.querySelector<HTMLElement>('.fx-x')?.focus({ preventScroll: true });
  if (reduceMotion()) return;
  const o = { duration: 300, easing: FOSI };
  const a = fx.anims;
  a.push(surface!.animate([{ clipPath: clipAt(from) }, { clipPath: ROUND }], o));
  a.push(surface!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: FOSI, pseudoElement: '::backdrop' }));
  for (const c of chrome()) a.push(c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 90, easing: FOSI, fill: 'backwards' }));
  if (fx.el) a.push(fx.el.node.animate([{ transform: over(fx.el, from) }, { transform: `scale(${fx.el.z})` }], o));
  else {
    const node = surface!.querySelector('.fx-stage')?.firstElementChild;
    if (node) a.push(node.animate([{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: 90, easing: FOSI, fill: 'backwards' }));
  }
}

// Centers the element in the stage, zoomed up to 2.2x when it is small.
function place(e: NonNullable<Live['el']>, rezoom: boolean) {
  const s = surface!.querySelector('.fx-stage')!.getBoundingClientRect();
  const box = { x: s.left + 48, y: s.top + 24, w: s.width - 96, h: s.height - 72 };
  const n = e.node;
  e.w = n.offsetWidth;
  const h = n.offsetHeight;
  // data-fx-real (prototypes) stays at 1:1: a zoomed live page resamples and blurs.
  if (rezoom) e.z = 'fxReal' in n.dataset ? 1 : Math.max(1, Math.min(2.2, box.w / e.w, box.h / h));
  e.L = Math.round(box.x + (box.w - e.w * e.z) / 2);
  e.T = Math.round(box.y + Math.max(0, (box.h - h * e.z) / 2));
  n.style.left = `${e.L}px`;
  n.style.top = `${e.T}px`;
  n.style.transform = `scale(${e.z})`;
  n.style.setProperty('--z', String(e.z));
}

function promote(e: NonNullable<Live['el']>) {
  const n = e.node;
  // Set and shown in one task, so the element is never styled as a hidden popover.
  n.setAttribute('popover', 'manual');
  n.dataset.fx = '';
  n.showPopover();
  place(e, true);
  e.ro.observe(n);
}

export function openElement(node: HTMLElement, label: string) {
  if (fx || closing || !surface) return;
  const from = node.getBoundingClientRect();
  const ph = document.createElement('div');
  ph.className = 'fx-ph';
  ph.style.cssText = `width:${from.width}px;height:${from.height}px`;
  node.before(ph);
  const el: NonNullable<Live['el']> = { node, ph, w: 1, L: 0, T: 0, z: 1, ro: new ResizeObserver(() => fx?.el === el && !closing && place(el, false)) };
  show({ mode: 'el', label }, from, { target: () => (ph.isConnected ? ph : null), el });
}

export function openText(source: ReadSource, from: Element) {
  if (fx || closing || !surface) return;
  const edit = source.edit;
  show({ mode: 'text', label: source.paste !== undefined ? source.label ?? 'Pasted text' : 'Reading', source }, from.getBoundingClientRect(), {
    target: () => (from.isConnected ? from : null),
    save: edit && (() => {
      const ta = surface?.querySelector<HTMLTextAreaElement>('.rd-edit');
      if (ta) edit(ta.value);
    }),
  });
}

function commit(f: Live) {
  const save = f.save;
  f.save = undefined;
  save?.();
}

export function openDiff(diff: DiffSource, label: string, from: Element) {
  if (fx || closing || !surface) return;
  show({ mode: 'diff', label, diff }, from.getBoundingClientRect(), { target: () => (from.isConnected ? from : null) });
}

export function openLogView(taskId: string, from: Element, label: string) {
  if (fx || closing || !surface) return;
  const row = () => document.querySelector(`.pr-open[data-proc="${CSS.escape(taskId)}"]`);
  show({ mode: 'log', label }, from.getBoundingClientRect(), { target: () => row() ?? null });
}

export function openPanel(view: Omit<Extract<View, { mode: 'panel' }>, 'mode'>, from: Element) {
  if (fx || closing || !surface) return;
  show({ mode: 'panel', ...view }, from.getBoundingClientRect(), { target: () => (from.isConnected ? from : null) });
}

function finish() {
  const f = fx;
  if (!f) return;
  commit(f);
  for (const a of f.anims) a.cancel();
  if (f.el) {
    const n = f.el.node;
    f.el.ro.disconnect();
    // Back in its slot in the same task, before anything can paint it hidden.
    n.hidePopover();
    n.removeAttribute('popover');
    delete n.dataset.fx;
    for (const p of ['left', 'top', 'transform', '--z']) n.style.removeProperty(p);
    f.el.ph.remove();
  }
  if (surface?.matches(':popover-open')) surface.hidePopover();
  if (f.mode === 'log') logClose?.();
  fx = null;
  closing = false;
  useFocus.setState({ view: null });
  if (f.back instanceof HTMLElement && f.back.isConnected) f.back.focus({ preventScroll: true });
}

export function closeFocus(instant = false) {
  if (!fx || closing || !surface) return;
  const f = fx;
  commit(f);
  const t = f.target();
  const tgt = t?.getBoundingClientRect();
  if (instant || reduceMotion() || !tgt || !tgt.width) return finish();
  closing = true;
  // Start from wherever the opening is now, so an early Esc reverses smoothly.
  const clip = getComputedStyle(surface).clipPath;
  const bd = getComputedStyle(surface, '::backdrop').opacity;
  const nodeNow = f.el?.node.getBoundingClientRect();
  for (const a of f.anims) a.cancel();
  f.anims = [];
  const sp = springEasing();
  const o: KeyframeAnimationOptions = { duration: sp.ms, easing: sp.easing, fill: 'forwards' };
  const done = surface.animate([{ clipPath: clip === 'none' ? ROUND : clip }, { clipPath: clipAt(tgt) }], o);
  f.anims.push(done, surface.animate([{ opacity: bd }, { opacity: 0 }], { ...o, pseudoElement: '::backdrop' }));
  for (const c of chrome()) f.anims.push(c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: FOSI, fill: 'forwards' }));
  if (f.el && nodeNow) f.anims.push(f.el.node.animate([{ transform: over(f.el, nodeNow) }, { transform: over(f.el, tgt) }], o));
  else {
    const node = surface.querySelector('.fx-stage')?.firstElementChild;
    if (node) f.anims.push(node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: FOSI, fill: 'forwards' }));
  }
  done.finished.then(finish, () => {});
}

const EXPAND = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.5 1.5h3v3M10.5 1.5 7 5M4.5 10.5h-3v-3M1.5 10.5 5 7" />
  </svg>
);

// The ⤢ that opens the frame it sits in; only the icon opens it, never the card.
export function FxBtn({ label, float }: { label: string; float?: boolean }) {
  return (
    <button
      type="button" className={`fx-btn${float ? ' float' : ''}`} aria-label={`Open ${label} full screen`} title="Full screen"
      onClick={(e) => {
        e.stopPropagation();
        const node = e.currentTarget.closest<HTMLElement>('.frame,.plan');
        if (node) openElement(node, label);
      }}
    >
      {EXPAND}
    </button>
  );
}

// The ⤢ beside agent prose: opens the message in the reader.
export function ReadBtn({ source }: { source: ReadSource }) {
  return (
    <button
      type="button" className="fx-btn sx" aria-label="Open in reader" title="Read full screen"
      onClick={(e) => {
        e.stopPropagation();
        openText(source, e.currentTarget.closest('.say') ?? e.currentTarget);
      }}
    >
      {EXPAND}
    </button>
  );
}

export function FocusView() {
  const view = useFocus((s) => s.view);
  const current = useStore((s) => s.current);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    surface = ref.current;
    return () => {
      surface = null;
    };
  }, []);

  // The conversation under a promoted frame is about to change; put it back at once.
  useEffect(() => () => closeFocus(true), [current]);

  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      const saveKey = e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.target as Element).matches?.('.rd-edit');
      if (e.key !== 'Escape' && !saveKey) return;
      e.preventDefault();
      e.stopPropagation();
      closeFocus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [view]);

  // A popover's backdrop is not hit-tested, so a click outside the surface and the promoted frame closes it.
  useEffect(() => {
    if (!view) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (e.button === 0 && !ref.current!.contains(t) && !t.closest?.('[data-fx]')) closeFocus();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [view]);

  const close = (
    <button className="sh-x fx-x" aria-label="Close" title="Close" onClick={() => closeFocus()}><kbd>esc</kbd></button>
  );
  return (
    <div className={`focus${view?.mode === 'text' ? ' text' : view?.mode === 'diff' ? ' dv-focus' : ''}`} popover="manual" ref={ref} role="dialog" aria-label={view?.label ?? 'Focused view'}>
      {view?.mode === 'text' || view?.mode === 'diff' ? (
        <ChunkGuard fallback={<div className="fx-top"><span className="sp"></span>{close}</div>}><Suspense fallback={null}><FocusBody view={view} close={close} /></Suspense></ChunkGuard>
      ) : (
        view && (
          <>
            <div className="fx-top"><span className="fx-label">{view.label}</span><span className="sp"></span>{close}</div>
            <div className="fx-stage" tabIndex={-1}>
              {view.mode === 'log' && <ChunkGuard><Suspense fallback={null}><FocusBody view={view} close={close} /></Suspense></ChunkGuard>}
              {view.mode === 'panel' && view.body}
            </div>
            <div className="fx-foot"><kbd>esc</kbd>close{view.mode === 'log' && ' · output keeps streaming while it runs'}{view.mode === 'panel' && view.foot && ` · ${view.foot}`}</div>
          </>
        )
      )}
    </div>
  );
}
