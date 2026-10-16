import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { useStore } from './store.ts';
import { reduceMotion, useEscape } from './bits.tsx';
import { SendImageBtn } from './SendToChat.tsx';

const EASE = 'cubic-bezier(.23,1,.32,1)';
const OPEN_MS = 240;
const CLOSE_MS = 200;

export function openImage(e: MouseEvent<HTMLImageElement>, full?: string) {
  const img = e.currentTarget;
  e.stopPropagation();
  useStore.setState({
    viewer: { src: img.currentSrc || img.src, full: full ?? null, alt: img.alt, from: img.getBoundingClientRect(), ratio: img.naturalWidth / img.naturalHeight || 1 },
  });
}

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

// The bubble's picture grows from where it sits into the middle of the window and shrinks back on close.
export function ImageViewer() {
  const v = useStore((s) => s.viewer);
  const boxRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  useLayoutEffect(() => {
    if (!v) return;
    closing.current = false;
    if (reduceMotion()) return;
    const to = fit(v.ratio);
    boxRef.current!.animate([{ transform: flip(v.from, to) }, { transform: 'none' }], { duration: OPEN_MS, easing: EASE });
    scrimRef.current!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE });
  }, [v]);

  const close = () => {
    if (!v || closing.current) return;
    closing.current = true;
    const done = () => useStore.setState({ viewer: null });
    if (reduceMotion()) return done();
    const to = fit(v.ratio);
    scrimRef.current!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: EASE, fill: 'forwards' });
    boxRef.current!.animate([{ transform: 'none' }, { transform: flip(v.from, to) }], { duration: CLOSE_MS, easing: EASE, fill: 'forwards' }).finished.then(done, done);
  };
  useEscape(!!v, close);

  if (!v) return null;
  const to = fit(v.ratio);
  return (
    <div className="iv" role="dialog" aria-modal="true" aria-label={v.alt || 'Image'} onClick={close}>
      <div className="iv-scrim" ref={scrimRef} />
      <div className="iv-box" ref={boxRef} style={{ left: to.left, top: to.top, width: to.width, height: to.height }}>
        <img src={v.src} alt={v.alt} />
        {v.full && v.full !== v.src && <img className="full" src={v.full} alt="" onLoad={(e) => e.currentTarget.classList.add('on')} />}
      </div>
      {/* Closes once the image is in the composer, so typing goes there. */}
      <SendImageBtn src={v.full ?? v.src} name={v.alt || 'Image'} className="stc-iv" onAdded={() => setTimeout(close, 650)} />
      <button className="iv-x" aria-label="Close" title="Close (esc)" autoFocus>
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
