import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { anchorOf } from '../Menus.tsx';

// The board and its engine load on the first open, outside the main bundle.
const Board = lazy(() => import('./Board.tsx'));

// The + menu's board row; the board opens as a full-window overlay and gives focus back to the + button on close.
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
      if (btn) anchorOf(btn).focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <>
      <button type="button" ref={btnRef} className="mi" role="menuitem" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="nm2">Drawing board</span>
      </button>
      {open && createPortal(<Suspense fallback={null}><Board onClose={() => setOpen(false)} /></Suspense>, document.body)}
    </>
  );
}
