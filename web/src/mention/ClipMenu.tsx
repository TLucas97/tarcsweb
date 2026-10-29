import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FolderIcon } from './useMention.tsx';

// The picker loads on its first use.
const Picker = lazy(() => import('./Picker.tsx'));

const UploadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 10.5V2.5M4.8 5.6 8 2.5l3.2 3.1M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />
  </svg>
);

// The paperclip: upload a file's content (images, PDFs, text) or reference any file or folder by its path.
// onArm runs on press, before focus leaves the prompt, so the composer can keep its selection.
export function ClipMenu({ icon, sessionId, onArm, onUpload, onPick }: {
  icon: ReactNode; sessionId: string | null; onArm: () => void; onUpload: () => void; onPick: (paths: string[]) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const pop = popRef.current!;
    const onToggle = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next) return;
      const r = btnRef.current!.getBoundingClientRect();
      const w = Math.min(parseFloat(getComputedStyle(pop).width), innerWidth - 24);
      pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
      pop.style.bottom = `${innerHeight - r.top + 10}px`;
    };
    pop.addEventListener('beforetoggle', onToggle);
    return () => pop.removeEventListener('beforetoggle', onToggle);
  }, []);

  const act = (fn: () => void) => () => {
    popRef.current!.hidePopover();
    fn();
  };

  return (
    <>
      <button
        type="button" ref={btnRef} className="attach" popoverTarget="clipPop" aria-haspopup="menu" aria-expanded={open}
        aria-label="Attach" title="Upload a file or reference one by path" onPointerDown={onArm}
      >
        {icon}
      </button>
      {createPortal(
        <div className="pop mpop ctx clip-pop" id="clipPop" popover="auto" ref={popRef} role="menu" aria-label="Attach">
          <button type="button" className="mi" role="menuitem" onClick={act(onUpload)}>
            <span className="nm2"><UploadIcon />Upload file</span><small>Images, PDFs and text files go to the model</small>
          </button>
          <button type="button" className="mi" role="menuitem" disabled={!sessionId} onClick={act(() => setPicking(true))}>
            <span className="nm2"><FolderIcon />Reference file or folder</span>
            <small>{sessionId ? 'Any file or folder; the agent gets its path' : 'Open a session first'}</small>
          </button>
        </div>,
        document.body,
      )}
      {picking && sessionId && (
        <Suspense fallback={null}>
          <Picker sessionId={sessionId} anchor={btnRef} onClose={() => setPicking(false)} onPick={(paths) => { setPicking(false); onPick(paths); }} />
        </Suspense>
      )}
    </>
  );
}
