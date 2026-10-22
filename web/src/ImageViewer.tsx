import { useEffect, useLayoutEffect, useReducer, useRef, type MouseEvent, type PointerEvent } from 'react';
import { useStore } from './store.ts';
import { reduceMotion, useEscape } from './bits.tsx';
import { SendImageBtn } from './SendToChat.tsx';

const EASE = 'cubic-bezier(.23,1,.32,1)';
const OPEN_MS = 240;
const CLOSE_MS = 200;
const ZOOM_MS = 200;
const ZOOM_MAX = 12;
// Pointer travel (px) past which a press is a pan, not a click.
const DRAG_PX = 4;

// The largest box with the picture's ratio that fits the window with a margin.
function fit(ratio: number) {
  const W = innerWidth - 48;
  const H = innerHeight - 48;
  const w = Math.min(W, H * ratio);
  const h = w / ratio;
  return { left: (innerWidth - w) / 2, top: (innerHeight - h) / 2, width: w, height: h };
}

type Box = { left: number; top: number; width: number; height: number };
// Module-level so the React Compiler never reads `from` while no image is open.
const flip = (f: DOMRect, to: Box) => `translate(${f.left - to.left}px, ${f.top - to.top}px) scale(${f.width / to.width}, ${f.height / to.height})`;

// Zoom and pan of the fitted box: screen = (x, y) + s * point. s = 1 is the fitted size.
type View = { s: number; x: number; y: number };
const FIT: View = { s: 1, x: 0, y: 0 };
const css = (v: View) => (v.s === 1 && !v.x && !v.y ? 'none' : `translate(${v.x}px, ${v.y}px) scale(${v.s})`);

// Keeps the screen point (px, py) still while the scale goes to s.
function zoomAt(v: View, s: number, px: number, py: number): View {
  const next = Math.min(ZOOM_MAX, Math.max(1, s));
  if (next === 1) return FIT;
  const k = next / v.s;
  return { s: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

// The bubble's picture grows from where it sits into the middle of the window and shrinks back on close. Wheel or pinch
// zooms, drag pans, double-click toggles fit and 1:1; the backdrop and Esc close.
export function ImageViewer() {
  const v = useStore((s) => s.viewer);
  const rootRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const view = useRef<View>(FIT);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);
  const [, refit] = useReducer((n: number) => n + 1, 0);

  const apply = (next: View, animate = false) => {
    const el = panRef.current;
    view.current = next;
    if (!el) return;
    const from = el.style.transform || 'none';
    el.style.transform = css(next);
    el.classList.toggle('zoomed', next.s > 1);
    if (animate && !reduceMotion()) el.animate([{ transform: from }, { transform: el.style.transform }], { duration: ZOOM_MS, easing: EASE });
  };

  useLayoutEffect(() => {
    if (!v) return;
    closing.current = false;
    view.current = FIT;
    if (panRef.current) panRef.current.style.transform = 'none';
    if (reduceMotion()) return;
    const to = fit(v.ratio);
    boxRef.current!.animate([{ transform: flip(v.from, to) }, { transform: 'none' }], { duration: OPEN_MS, easing: EASE });
    scrimRef.current!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE });
  }, [v]);

  // A resized window re-fits the picture and drops the zoom.
  useEffect(() => {
    if (!v) return;
    const onResize = () => {
      view.current = FIT;
      if (panRef.current) panRef.current.style.transform = 'none';
      refit();
    };
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, [v]);

  // Wheel needs a non-passive listener to keep the page from scrolling; a trackpad pinch arrives as ctrl+wheel.
  useEffect(() => {
    const el = rootRef.current;
    if (!v || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (closing.current) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const cur = view.current;
      apply(zoomAt(cur, cur.s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [v]);

  const close = () => {
    if (!v || closing.current) return;
    closing.current = true;
    const done = () => useStore.setState({ viewer: null });
    if (reduceMotion()) return done();
    const to = fit(v.ratio);
    if (view.current !== FIT) apply(FIT, true);
    scrimRef.current!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: EASE, fill: 'forwards' });
    boxRef.current!.animate([{ transform: 'none' }, { transform: flip(v.from, to) }], { duration: CLOSE_MS, easing: EASE, fill: 'forwards' }).finished.then(done, done);
  };
  useEscape(!!v, close);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || closing.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const ps = pointers.current;
    const was = ps.get(e.pointerId);
    if (!was) return;
    const now = { x: e.clientX, y: e.clientY };
    if (ps.size >= 2) {
      // Pinch: scale by the change in distance between the two pointers, around their midpoint.
      const other = [...ps].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(was.x - other.x, was.y - other.y);
      const after = Math.hypot(now.x - other.x, now.y - other.y);
      moved.current = true;
      if (before > 0) apply(zoomAt(view.current, view.current.s * (after / before), (now.x + other.x) / 2, (now.y + other.y) / 2));
    } else if (moved.current || Math.hypot(now.x - was.x, now.y - was.y) > DRAG_PX) {
      moved.current = true;
      const cur = view.current;
      if (cur.s > 1) apply({ ...cur, x: cur.x + now.x - was.x, y: cur.y + now.y - was.y });
    } else return;
    ps.set(e.pointerId, now);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => void pointers.current.delete(e.pointerId);

  // Fit and 1:1 (the image's own pixels, from the sharper copy once it loaded) around the clicked point.
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (!v || !box) return;
    const cur = view.current;
    if (cur.s > 1) return apply(FIT, true);
    const img = box.querySelector<HTMLImageElement>('img.full.on') ?? box.querySelector('img');
    const real = img?.naturalWidth ? img.naturalWidth / fit(v.ratio).width : 2;
    apply(zoomAt(cur, real > 1.05 ? real : 2, e.clientX, e.clientY), true);
  };

  if (!v) return null;
  const to = fit(v.ratio);
  return (
    <div
      ref={rootRef} className="iv" role="dialog" aria-modal="true" aria-label={v.alt || 'Image'}
      onPointerDownCapture={() => pointers.current.size || (moved.current = false)}
      onClick={(e) => {
        // A pan that ended outside the picture is not a backdrop click.
        if (moved.current || (e.target as Element).closest('.iv-box')) return;
        close();
      }}
    >
      <div className="iv-scrim" ref={scrimRef} />
      <div className="iv-pan" ref={panRef}>
        <div
          className="iv-box" ref={boxRef} style={{ left: to.left, top: to.top, width: to.width, height: to.height }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={onDoubleClick}
        >
          <img src={v.src} alt={v.alt} draggable={false} />
          {v.full && v.full !== v.src && <img className="full" src={v.full} alt="" draggable={false} onLoad={(e) => e.currentTarget.classList.add('on')} />}
        </div>
      </div>
      {/* Closes once the image is in the composer, so typing goes there. */}
      <SendImageBtn src={v.full ?? v.src} name={v.alt || 'Image'} className="stc-iv" onAdded={() => setTimeout(close, 650)} />
      <button className="iv-x" aria-label="Close" title="Close (esc)" autoFocus>
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
