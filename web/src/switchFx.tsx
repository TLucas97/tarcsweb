import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useStore } from './store.ts';
import { reduceMotion } from './bits.tsx';

// A switch animates only shortly after a pointer press; any key clears it, so keyboard switches stay instant.
let pointerAt = 0;
const POINTER_MS = 1500;
// The old view holds this long at most for an uncached backlog; then the pieces come in anyway.
const LOAD_WAIT = 300;
const OUT_MS = 120;
const PIECE_MS = 240;
const GLINT_MS = 280;
const STAGGER = 45;
const TRAVEL = 20;
const EASE = 'cubic-bezier(.34,1.4,.64,1)';
const THIRDS = ['inset(0 66.66% 0 0)', 'inset(0 33.33% 0 33.33%)', 'inset(0 0 0 66.66%)'];

// Iframes and videos would reload in a copy: a still frame or an empty box of the same size stands in. Canvases keep their pixels.
function copy<T extends Element>(el: T): T {
  const out = el.cloneNode(true) as T;
  const media = el.querySelectorAll('iframe,canvas,video');
  if (!media.length) return out;
  const dst = out.querySelectorAll('iframe,canvas,video');
  media.forEach((src, i) => {
    if (src instanceof HTMLCanvasElement) {
      try { (dst[i] as HTMLCanvasElement).getContext('2d')?.drawImage(src, 0, 0); } catch { /* tainted or zero-sized */ }
      return;
    }
    const s = src as HTMLElement;
    const still = src instanceof HTMLVideoElement && src.readyState >= 2;
    const box = document.createElement(still ? 'canvas' : 'div');
    box.className = s.className;
    box.style.cssText = `display:block;width:${s.offsetWidth}px;height:${s.offsetHeight}px`;
    if (still) {
      const v = src as HTMLVideoElement;
      Object.assign(box, { width: v.videoWidth, height: v.videoHeight });
      (box as HTMLCanvasElement).getContext('2d')?.drawImage(v, 0, 0);
    }
    dst[i].replaceWith(box);
  });
  return out;
}

const near = (b: DOMRect, r: DOMRect) => b.bottom > r.top - TRAVEL && b.top < r.bottom + TRAVEL;

// An empty box holding the height of a block that sits above the view, so what follows stays in place.
function stub(el: Element, h: number) {
  const media = /^(IFRAME|VIDEO|IMG|CANVAS)$/.test(el.tagName);
  const s = (media ? document.createElement('div') : el.cloneNode(false)) as HTMLElement;
  if (media) s.className = (el as HTMLElement).className;
  s.style.cssText += `;box-sizing:border-box;height:${h}px;min-height:0;max-height:none;overflow:hidden`;
  return s;
}

// A row taller than the view is copied in parts: blocks above the view become stubs, blocks below are dropped.
function part(el: Element, b: DOMRect, r: DOMRect): Element {
  if (b.height <= r.height || !el.childElementCount) return copy(el);
  const out = el.cloneNode(false) as Element;
  for (const n of el.childNodes) {
    if (!(n instanceof Element)) {
      out.append(n.cloneNode());
      continue;
    }
    const c = n.getBoundingClientRect();
    const sized = c.height > 0;
    if (sized && c.top >= r.bottom + TRAVEL) break;
    const d = sized && !near(c, r) ? getComputedStyle(n).display : '';
    out.append(d && !d.startsWith('inline') && d !== 'contents' ? stub(n, c.height) : part(n, c, r));
  }
  return out;
}

// A copy of only the rows on screen, placed where they sit, so the cost stays flat however long the conversation is.
function slice(conv: HTMLElement, r: DOMRect) {
  const shell = conv.cloneNode(false) as HTMLElement;
  shell.style.cssText = 'position:absolute;inset:0;overflow:hidden';
  const col = conv.firstElementChild as HTMLElement | null;
  if (!col) return shell;
  const rows = col.children;
  const box = (i: number) => rows[i].getBoundingClientRect();
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (box(m).bottom <= r.top - TRAVEL) lo = m + 1;
    else hi = m;
  }
  const inner = col.cloneNode(false) as HTMLElement;
  let top: number | null = null;
  for (let i = lo; i < rows.length; i++) {
    const b = box(i);
    if (b.top >= r.bottom + TRAVEL && b.height) break;
    // Empty or hidden rows before the first visible one would add a gap.
    if (top === null && (!b.height || !near(b, r))) continue;
    top ??= b.top;
    inner.append(part(rows[i], b, r));
  }
  const c = col.getBoundingClientRect();
  inner.style.cssText = `position:absolute;margin:0;left:${c.left - r.left}px;top:${(top ?? r.top) - r.top}px;width:${c.width}px`;
  shell.append(inner);
  return shell;
}

type Snap = { to: string; rect: DOMRect; node: HTMLElement };

// The old view fades while copies of the new one arrive as three columns: the sides drop in, the middle rises.
function play(fx: HTMLDivElement, conv: HTMLElement, snap: Snap) {
  const r = snap.rect;
  Object.assign(fx.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const glints = [...fx.querySelectorAll(':scope>b')];
  const added: Element[] = [snap.node];
  fx.prepend(snap.node);
  fx.hidden = false;
  // Not 0: at 0 Chrome drops the scroller's paint and repaints all of it on the way back (hundreds of ms at 4x).
  conv.style.opacity = '0.001';
  const anims: Animation[] = [];
  let over = false;
  let started = false;
  let frame = 0;
  let wait = 0;
  let unsub = () => {};
  const finish = () => {
    if (over) return;
    over = true;
    unsub();
    clearTimeout(wait);
    cancelAnimationFrame(frame);
    for (const a of anims) a.cancel();
    for (const n of added) n.remove();
    conv.style.removeProperty('opacity');
    fx.hidden = true;
  };
  const go = () => {
    unsub();
    clearTimeout(wait);
    if (over || started) return;
    started = true;
    const first = slice(conv, conv.getBoundingClientRect());
    // The real view stays still under the copies; animating it costs a repaint of the whole conversation.
    const pieces = [first, copy(first), copy(first)];
    // The old view holds until the pieces are ready, so a slow frame never leaves the view blank.
    anims.push(snap.node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: OUT_MS, easing: 'ease-out', fill: 'forwards' }));
    pieces.forEach((piece, i) => {
      piece.style.clipPath = THIRDS[i];
      fx.insertBefore(piece, glints[0]);
      added.push(piece);
      const dy = `translateY(${i === 1 ? TRAVEL : -TRAVEL}px)`;
      const t = { delay: i * STAGGER, fill: 'both' as const };
      anims.push(
        piece.animate([{ transform: dy, opacity: 0 }, { transform: 'none', opacity: 1 }], { ...t, duration: PIECE_MS, easing: EASE }),
        glints[i].animate([{ transform: dy, opacity: 0 }, { opacity: 1, offset: 0.4 }, { transform: 'none', opacity: 0 }], { ...t, duration: GLINT_MS, easing: EASE }),
      );
    });
    anims[anims.length - 1].finished.then(finish, () => {});
  };
  // Two frames, so the scroll pinned to the bottom by Conversation's observer has settled before rows are measured.
  const settle = () => (frame = requestAnimationFrame(() => (frame = requestAnimationFrame(go))));
  if (useStore.getState().loading) {
    unsub = useStore.subscribe((s) => void (!s.loading && (unsub(), settle())));
    wait = window.setTimeout(go, LOAD_WAIT);
  } else settle();
  return finish;
}

// Session-switch reveal; renders nothing visible until a click changes the session.
export function SwitchFx({ convRef }: { convRef: RefObject<HTMLElement | null> }) {
  const current = useStore((s) => s.current);
  const ref = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | null>(null);
  const snap = useRef<Snap | null>(null);

  useEffect(() => {
    const onPointer = () => void (pointerAt = Date.now());
    const onKey = () => void (pointerAt = 0);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    // The store changes before React renders, so the old rows are still on screen to copy.
    const unsub = useStore.subscribe((s, p) => {
      if (s.current === p.current) return;
      stop.current?.();
      stop.current = null;
      snap.current = null;
      const conv = convRef.current;
      const clicked = Date.now() - pointerAt < POINTER_MS;
      pointerAt = 0;
      if (!conv || !p.current || !s.current || !clicked || reduceMotion()) return;
      const rect = conv.getBoundingClientRect();
      snap.current = { to: s.current, rect, node: slice(conv, rect) };
    });
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      unsub();
      stop.current?.();
    };
  }, [convRef]);

  // Before paint, so the new session never shows outside its pieces.
  useLayoutEffect(() => {
    const s = snap.current;
    snap.current = null;
    if (s?.to === current) stop.current = play(ref.current!, convRef.current!, s);
  }, [current, convRef]);

  return (
    <div className="swfx" ref={ref} hidden aria-hidden="true" inert>
      <b></b><b></b><b></b>
    </div>
  );
}
