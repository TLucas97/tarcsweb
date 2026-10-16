import { Suspense, lazy, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isReady, useSetup } from './setup.ts';

const loadSettings = () => import('./Settings.tsx');
const Settings = lazy(loadSettings);
const Connect = lazy(() => import('./Connect.tsx'));

const GearIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.68 2.7 5.84 1.01h2.32l.16 1.69a4.5 4.5 0 0 1 1.75 1.01L11.6 3l1.17 2.01-1.39.98a4.5 4.5 0 0 1 0 2.02l1.39.98L11.6 11l-1.53-.71a4.5 4.5 0 0 1-1.75 1.01l-.16 1.69H5.84l-.16-1.69a4.5 4.5 0 0 1-1.75-1.01L2.4 11 1.23 8.99l1.39-.98a4.5 4.5 0 0 1 0-2.02L1.23 5.01 2.4 3l1.53.71A4.5 4.5 0 0 1 5.68 2.7Z" />
    <circle cx="7" cy="7" r="2" />
  </svg>
);

// The header's only button; the dialog and its code load on the first click.
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  // The dialog grows out of this button and shrinks back into it.
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      {/* Fetching the chunk on hover means the click opens it in the same frame. */}
      <button type="button" className="fnd-open set-gear" ref={btn} aria-label="Settings" title="Settings" aria-haspopup="dialog" aria-expanded={open} onPointerEnter={loadSettings} onFocus={loadSettings} onClick={() => setOpen(true)}>
        <GearIcon />
      </button>
      {open && createPortal(<Suspense fallback={null}><Settings origin={btn} onClose={() => setOpen(false)} /></Suspense>, document.body)}
    </>
  );
}

// Covers the app while nothing can run a session: the CLI is signed out.
export function ConnectGate() {
  const ready = useSetup((s) => isReady(s.status));
  if (ready) return null;
  return <Suspense fallback={null}><Connect /></Suspense>;
}
