import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The board and its engine load on the first open, outside the main bundle.
const Board = lazy(() => import('./Board.tsx'));

const BoardIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.25" /><path d="M4.5 10.5c1.2-2.6 2.4-3.9 3.3-2.7.8 1.1 1.6.9 3.7-2.3" />
  </svg>
);

// The composer's board button; the board opens as a full-window overlay and gives focus back here on close.
export function BoardButton() {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // The app under the board stops painting while it is open, like watch mode.
  useEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    document.body.dataset.board = '';
    return () => {
      delete document.body.dataset.board;
      btn?.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <>
      <button type="button" ref={btnRef} className="attach" aria-label="Drawing board" title="Drawing board" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <BoardIcon />
      </button>
      {open && createPortal(<Suspense fallback={null}><Board onClose={() => setOpen(false)} /></Suspense>, document.body)}
    </>
  );
}
