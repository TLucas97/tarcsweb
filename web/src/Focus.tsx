import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type ReactNode, type RefCallback } from 'react';
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

// A card that opts into the stage layout: its header hides and the viewer draws a title chip and action bars.
// scale: a fixed canvas, fit whole and zoomed up to 3x; fill: the card takes the whole stage and reflows.
export type Stage = { kind: string; fit: 'scale' | 'fill' };
// Empty elements in the stage chrome; the open card renders its controls into them with createPortal.
export type FullSlots = { extra: HTMLElement; tools: HTMLElement; acts: HTMLElement; foot: HTMLElement };

// The fullscreen focus view. Frames stay where React put them and are promoted to the top layer
// (popover="manual"), so live iframes never reload; text and logs render a fresh copy in the stage.
export type View =
  // id is the card's data-id, so a staged card can find its slots.
  | { mode: 'el'; label: string; id?: string; stage?: Stage } | { mode: 'text'; label: string; source: ReadSource } | { mode: 'log'; label: string }
  | { mode: 'diff'; label: string; diff: DiffSource }
  // A body another module owns (the file tree); key tells which one is up.
  | { mode: 'panel'; label: string; key: string; body: ReactNode; foot?: string };
export const useFocus = create<{ view: View | null; slots: FullSlots | null }>(() => ({ view: null, slots: null }));
// The slots while the card with this data-id is open in the stage layout, else null.
export const useFull = (id: string) => useFocus((s) => (s.view?.mode === 'el' && s.view.stage && s.view.id === id ? s.slots : null));

const FOSI = 'cubic-bezier(.4,0,.2,1)';
// Auto and hint popovers open over the view; the view itself and a lifted card are manual.
const OPEN_POP = ':popover-open:not([popover=manual])';
const ROUND = 'inset(0 round 16px)';
const STAGE_ROUND = 'inset(0 round 10px)';
// Stage layout: the card keeps PAD from the window edges and GAP from the bars.
const PAD = 16;
const GAP = 12;

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

type El = {
  node: HTMLElement; ph: HTMLElement; w: number; L: number; T: number; z: number; ro: ResizeObserver;
  // Stage layout only: the fit, and where and how wide the body below the hidden header sat in the card.
  fit?: Stage['fit']; dx: number; dy: number; bw: number;
};
type Live = {
  mode: View['mode'];
  // Where the view closes back into; null when it left the screen.
  target: () => Element | null;
  el?: El;
  anims: Animation[];
  back: Element | null;
  // Hands an edited paste back to its owner; runs once, before the view goes away.
  save?: () => void;
};
let fx: Live | null = null;
let closing = false;
let surface: HTMLElement | null = null;

const chrome = () => [...surface!.querySelectorAll<HTMLElement>('.fx-top,.rd-prog,.fx-foot,.fv-chip,.fv-bar,.fv-foot')];
const roundOf = (f: Live) => (f.el?.fit ? STAGE_ROUND : ROUND);
function clipAt(r: DOMRect, rad = 12) {
  const d = surface!.getBoundingClientRect();
  return `inset(${r.top - d.top}px ${d.right - r.right}px ${d.bottom - r.bottom}px ${r.left - d.left}px round ${rad}px)`;
}
// Transform that lays the promoted element (origin 0 0 at L,T, unscaled width w) over rect r.
const over = (e: El, r: DOMRect) => `translate(${r.left - e.L}px,${r.top - e.T}px) scale(${r.width / e.w})`;
// A staged node has no header, so it maps onto the card's body; a canvas lifted at native size lands there scaled down.
const bodyOf = (e: El, r: DOMRect) => (e.fit ? new DOMRect(r.left + e.dx, r.top + e.dy, e.bw, 0) : r);

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
  a.push(surface!.animate([{ clipPath: clipAt(from) }, { clipPath: roundOf(fx) }], o));
  a.push(surface!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: FOSI, pseudoElement: '::backdrop' }));
  for (const c of chrome()) a.push(c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 90, easing: FOSI, fill: 'backwards' }));
  if (fx.el) a.push(fx.el.node.animate([{ transform: over(fx.el, bodyOf(fx.el, from)) }, { transform: `scale(${fx.el.z})` }], o));
  else {
    const node = surface!.querySelector('.fx-stage')?.firstElementChild;
    if (node) a.push(node.animate([{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: 90, easing: FOSI, fill: 'backwards' }));
  }
}

// Centers the element in the stage, zoomed up to 2.2x when it is small.
function place(e: El, rezoom: boolean) {
  const n = e.node;
  if (e.fit) {
    // The stage layout: the window below the top bars and above the bottom bar, so no bar covers the card.
    const s = surface!.getBoundingClientRect();
    const y = surface!.querySelector('.fv-top')!.getBoundingClientRect().bottom + GAP;
    const foot = surface!.querySelector('.fv-foot')!.getBoundingClientRect();
    const box = { x: s.left + PAD, y, w: s.width - 2 * PAD, h: Math.max(0, (foot.height ? foot.top - GAP : s.bottom - PAD) - y) };
    if (e.fit === 'fill') {
      n.style.width = `${box.w}px`;
      n.style.height = `${box.h}px`;
      e.w = box.w;
      e.z = 1;
      e.L = Math.round(box.x);
      e.T = Math.round(box.y);
    } else {
      e.w = n.offsetWidth;
      const h = n.offsetHeight;
      e.z = Math.max(0.1, Math.min(3, box.w / e.w, box.h / h));
      e.L = Math.round(box.x + (box.w - e.w * e.z) / 2);
      e.T = Math.round(box.y + (box.h - h * e.z) / 2);
    }
  } else {
    const s = surface!.querySelector('.fx-stage')!.getBoundingClientRect();
    const box = { x: s.left + 48, y: s.top + 24, w: s.width - 96, h: s.height - 72 };
    e.w = n.offsetWidth;
    const h = n.offsetHeight;
    // data-fx-real (prototypes) stays at 1:1: a zoomed live page resamples and blurs.
    if (rezoom) e.z = 'fxReal' in n.dataset ? 1 : Math.max(1, Math.min(2.2, box.w / e.w, box.h / h));
    e.L = Math.round(box.x + (box.w - e.w * e.z) / 2);
    e.T = Math.round(box.y + Math.max(0, (box.h - h * e.z) / 2));
  }
  n.style.left = `${e.L}px`;
  n.style.top = `${e.T}px`;
  n.style.transform = `scale(${e.z})`;
  n.style.setProperty('--z', String(e.z));
}

function promote(e: El) {
  const n = e.node;
  // Set and shown in one task, so the element is never styled as a hidden popover.
  n.setAttribute('popover', 'manual');
  n.dataset.fx = '';
  if (e.fit) n.dataset.fxStage = e.fit;
  n.showPopover();
  place(e, true);
  e.ro.observe(n);
  // A window resize, the top bars wrapping or a bottom bar filling in changes the box.
  if (e.fit) for (const o of [surface!, surface!.querySelector('.fv-top'), surface!.querySelector('.fv-foot')]) if (o) e.ro.observe(o);
}

export function openElement(node: HTMLElement, label: string, stage?: Stage) {
  if (fx || closing || !surface) return;
  const from = node.getBoundingClientRect();
  // Measured before the header hides: the body's offset in the card, where the open and close animations land.
  const body = stage && node.querySelector(':scope>.fh')?.nextElementSibling?.getBoundingClientRect();
  const ph = document.createElement('div');
  ph.className = 'fx-ph';
  ph.style.cssText = `width:${from.width}px;height:${from.height}px`;
  node.before(ph);
  const el: El = {
    node, ph, w: 1, L: 0, T: 0, z: 1, fit: stage?.fit,
    dx: body ? body.left - from.left : 0, dy: body ? body.top - from.top : 0, bw: body ? body.width : from.width,
    ro: new ResizeObserver(() => fx?.el === el && !closing && place(el, false)),
  };
  show({ mode: 'el', label, id: node.dataset.id, stage }, from, { target: () => (ph.isConnected ? ph : null), el });
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
    delete n.dataset.fxStage;
    for (const p of ['left', 'top', 'transform', '--z', ...(f.el.fit === 'fill' ? ['width', 'height'] : [])]) n.style.removeProperty(p);
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
  const done = surface.animate([{ clipPath: clip === 'none' ? roundOf(f) : clip }, { clipPath: clipAt(tgt) }], o);
  f.anims.push(done, surface.animate([{ opacity: bd }, { opacity: 0 }], { ...o, pseudoElement: '::backdrop' }));
  for (const c of chrome()) f.anims.push(c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: FOSI, fill: 'forwards' }));
  if (f.el && nodeNow) f.anims.push(f.el.node.animate([{ transform: over(f.el, nodeNow) }, { transform: over(f.el, bodyOf(f.el, tgt)) }], o));
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
export function FxBtn({ label, float, stage }: { label: string; float?: boolean; stage?: Stage }) {
  return (
    <button
      type="button" className={`fx-btn${float ? ' float' : ''}`} aria-label={`Open ${label} full screen`} title="Full screen"
      onClick={(e) => {
        e.stopPropagation();
        const node = e.currentTarget.closest<HTMLElement>('.frame,.plan');
        if (node) openElement(node, label, stage);
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

const XICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export function CloseBtn({ onClose }: { onClose: () => void }) {
  return <button type="button" className="fv-ic fx-x" aria-label="Close" title="Close (Esc)" onClick={() => onClose()}>{XICON}</button>;
}

// The stage layout's floating chrome: a title chip top left, actions top right, an optional bar at the bottom.
// Empty slots hide; content comes as props or, for a lifted card, through portals into the slots (useFull).
// children: a body rendered between the top bars and the foot, so the tab order follows the screen.
export function ViewerChrome({ kind, label, onClose, extra, tools, acts, foot, bind, children }: {
  kind: string; label: string; onClose: () => void;
  extra?: ReactNode; tools?: ReactNode; acts?: ReactNode; foot?: ReactNode;
  bind?: RefCallback<HTMLDivElement>; children?: ReactNode;
}) {
  return (
    <div className="fv-ui" ref={bind}>
      <div className="fv-top">
        <div className="fv-chip">
          <span className="tool mono">{kind}</span>
          <span className="fv-t" title={label}>{label}</span>
          <span className="fv-extra">{extra}</span>
        </div>
        <div className="fv-bar" role="group" aria-label="Actions">
          <span className="fv-tools">{tools}</span>
          <span className="fv-acts">{acts}</span>
          <CloseBtn onClose={onClose} />
        </div>
      </div>
      {children}
      <div className="fv-foot">{foot}</div>
    </div>
  );
}

// Publishes the slots once the chrome mounts; module level, so React never re-binds it.
function bindSlots(el: HTMLDivElement | null) {
  if (!el) return;
  const q = (c: string) => el.querySelector<HTMLElement>(c)!;
  useFocus.setState({ slots: { extra: q('.fv-extra'), tools: q('.fv-tools'), acts: q('.fv-acts'), foot: q('.fv-foot') } });
  return () => useFocus.setState({ slots: null });
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
      // An open menu or note takes Esc first; the browser closes it.
      if (e.key === 'Escape' && document.querySelector(OPEN_POP)) return;
      e.preventDefault();
      e.stopPropagation();
      closeFocus();
    };
    // Esc inside a frame never reaches this document; the bridge in frameDoc.ts posts it, honored only from the open card's frames.
    const onMsg = (e: MessageEvent) => {
      const frames = e.data?.fxEsc === 1 ? fx?.el?.node.querySelectorAll('iframe') : undefined;
      if (!frames || ![...frames].some((f) => f.contentWindow === e.source)) return;
      // The browser never sees this Esc, so it closes the newest open popover by hand (nested ones come later in the DOM).
      const pop = [...document.querySelectorAll<HTMLElement>(OPEN_POP)].at(-1);
      if (pop) pop.hidePopover();
      else closeFocus();
    };
    document.addEventListener('keydown', onKey, true);
    addEventListener('message', onMsg);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      removeEventListener('message', onMsg);
    };
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

  const close = <CloseBtn onClose={closeFocus} />;
  const staged = view?.mode === 'el' && view.stage;
  const foot = view?.mode === 'log' ? 'Output keeps streaming while it runs' : view?.mode === 'panel' ? view.foot : undefined;
  return (
    <div className={`focus${view?.mode === 'text' ? ' text' : view?.mode === 'diff' ? ' dv-focus' : staged ? ' fv' : ''}`} popover="manual" ref={ref} role="dialog" aria-label={view?.label ?? 'Focused view'}>
      {view?.mode === 'text' || view?.mode === 'diff' ? (
        <ChunkGuard fallback={<div className="fx-top"><span className="sp"></span>{close}</div>}><Suspense fallback={null}><FocusBody view={view} close={close} /></Suspense></ChunkGuard>
      ) : staged ? (
        <ViewerChrome kind={staged.kind} label={view.label} onClose={closeFocus} bind={bindSlots} />
      ) : (
        view && (
          <>
            <div className="fx-top"><span className="fx-label">{view.label}</span><span className="sp"></span>{close}</div>
            <div className="fx-stage" tabIndex={-1}>
              {view.mode === 'log' && <ChunkGuard><Suspense fallback={null}><FocusBody view={view} close={close} /></Suspense></ChunkGuard>}
              {view.mode === 'panel' && view.body}
            </div>
            {foot && <div className="fx-foot">{foot}</div>}
          </>
        )
      )}
    </div>
  );
}
