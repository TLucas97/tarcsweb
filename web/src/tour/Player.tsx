import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { FOSI, XIcon, reduceMotion, trapTab } from '../bits.tsx';
import { closeTour, stepTour, type Play } from './state.ts';

const OUT = 'cubic-bezier(.23,1,.32,1)';

export default function Player({ play }: { play: Play }) {
  const layer = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Focus goes back where it was: the invite, or a row in Settings > Tour.
  const back = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  const { list, at } = play;
  const c = list[at];
  const last = at === list.length - 1;
  const still = reduceMotion();

  useLayoutEffect(() => {
    back.current = document.activeElement as HTMLElement | null;
    const l = layer.current!;
    l.showPopover();
    const ms = still ? 120 : 240;
    l.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: OUT, pseudoElement: '::before' });
    box.current!.animate(still ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(8px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: ms, easing: OUT });
    box.current!.querySelector<HTMLElement>('.tour-next')?.focus({ preventScroll: true });
  }, []);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const done = () => {
      if (back.current?.isConnected) back.current.focus({ preventScroll: true });
      closeTour();
    };
    const q = { duration: still ? 100 : 160, easing: FOSI, fill: 'forwards' } as const;
    layer.current!.animate([{ opacity: 1 }, { opacity: 0 }], { ...q, pseudoElement: '::before' });
    box.current!.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: still ? 'none' : 'scale(.97)' }], q).finished.then(done, done);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keeps the app's global keys, and Settings underneath, away from the player.
    e.stopPropagation();
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      stepTour(at + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (e.key === 'Tab') trapTab(e);
  };

  return (
    <div
      className="set-layer" popover="manual" ref={layer} onKeyDown={onKeyDown}
      onPointerDown={(e) => e.target === e.currentTarget && e.preventDefault()}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="tour" ref={box} role="dialog" aria-modal="true" aria-labelledby="tour-t" aria-describedby="tour-d" tabIndex={-1}>
        <div className="tour-stage">
          {c.clip
            // Reduced motion gets the controls instead of a clip that starts on its own.
            ? <video key={c.id} src={`/tour/${c.clip}`} autoPlay={!still} controls={still} muted loop playsInline />
            : <div className="tour-soon" aria-hidden="true"><b>{at + 1}</b><span>Clip coming soon</span></div>}
        </div>
        <div className="tour-body" key={c.id}>
          <span className="tour-n">{at + 1} of {list.length}</span>
          <h2 id="tour-t">{c.title}</h2>
          <p id="tour-d">{c.blurb}</p>
        </div>
        <div className="tour-foot">
          {list.length > 1 && (
            <div className="tour-segs">
              {list.map((x, i) => (
                <button key={x.id} type="button" aria-label={`${i + 1}. ${x.title}`} title={x.title} aria-current={i === at ? 'step' : undefined} onClick={() => stepTour(i)}><i /></button>
              ))}
            </div>
          )}
          <button
            type="button" className="tour-ghost" disabled={at === 0}
            onClick={() => {
              stepTour(at - 1);
              // Back disables itself on the first clip; focus moves on so the keys keep working.
              if (at === 1) box.current!.querySelector<HTMLElement>('.tour-next')?.focus({ preventScroll: true });
            }}
          >Back</button>
          <button type="button" className="set-btn tour-next" onClick={last ? close : () => stepTour(at + 1)}>{last ? 'Done' : 'Next'}</button>
        </div>
        <button type="button" className="set-x" aria-label="Close" title="Close (esc)" onClick={close}><XIcon /></button>
      </div>
    </div>
  );
}
