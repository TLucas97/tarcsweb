import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayoutVars } from '../layoutVars.ts';
import { SkillIcon, type SkillRef } from './ref.tsx';

// The library and its tree load on the first open.
const Library = lazy(() => import('./Library.tsx'));

type Props = { sessionId: string | null; chips: SkillRef[]; onToggle: (r: SkillRef) => void; draft: () => string; slashOn: boolean };

// The composer's skills button and its card; the card sits over the composer and follows its height through --ch.
export function SkillsButton(props: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const bindVars = useLayoutVars(popRef);
  const [open, setOpen] = useState(false);
  // Stays mounted after the first open, so a reopen keeps the folder and search.
  const [ever, setEver] = useState(false);
  useEffect(() => {
    const pop = popRef.current!;
    const onToggle = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next) return;
      setEver(true);
      // As wide as the composer allows, but its left edge starts at the button, clamped to the window.
      const form = (btnRef.current!.closest('form') ?? btnRef.current!).getBoundingClientRect();
      const r = btnRef.current!.getBoundingClientRect();
      const w = Math.min(620, form.width, innerWidth - 24);
      pop.style.width = `${w}px`;
      pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
    };
    pop.addEventListener('beforetoggle', onToggle);
    return () => pop.removeEventListener('beforetoggle', onToggle);
  }, []);
  return (
    <>
      <button
        type="button" ref={btnRef} className="attach sk-btn" popoverTarget="skillsPop" aria-haspopup="dialog" aria-expanded={open}
        aria-label="Skills library" title="Skills library"
      >
        <SkillIcon />
      </button>
      {createPortal(
        <div className="sk-pop" id="skillsPop" popover="auto" ref={bindVars} role="dialog" aria-label="Skills library">
          {ever && (
            <Suspense fallback={<div className="sk-wait" role="status">Loading skills…</div>}>
              <Library {...props} open={open} />
            </Suspense>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
