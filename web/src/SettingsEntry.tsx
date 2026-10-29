import { Suspense, lazy, useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { isReady, useSetup } from './setup.ts';
import { isLite } from './perf.ts';

// A plain module ref, not React.lazy: lazy suspends on its first render even when the chunk is in, and React holds that reveal ~300 ms.
let Settings: typeof import('./Settings.tsx').default | null = null;
let loading: Promise<void> | null = null;
function loadSettings() {
  loading ??= import('./Settings.tsx').then((m) => {
    Settings = m.default;
    // The font tiles preview both faces; Noto Serif is font-display: block, so it would draw blank until fetched.
    void document.fonts.load('1em "Noto Serif App"', 'Aa Noto Serif').catch(() => {});
    void document.fonts.load('1em Lexend', 'Aa Lexend').catch(() => {});
  }, () => {
    loading = null;
  });
  return loading;
}
const Connect = lazy(() => import('./Connect.tsx'));

const GearIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.68 2.7 5.84 1.01h2.32l.16 1.69a4.5 4.5 0 0 1 1.75 1.01L11.6 3l1.17 2.01-1.39.98a4.5 4.5 0 0 1 0 2.02l1.39.98L11.6 11l-1.53-.71a4.5 4.5 0 0 1-1.75 1.01l-.16 1.69H5.84l-.16-1.69a4.5 4.5 0 0 1-1.75-1.01L2.4 11 1.23 8.99l1.39-.98a4.5 4.5 0 0 1 0-2.02L1.23 5.01 2.4 3l1.53.71A4.5 4.5 0 0 1 5.68 2.7Z" />
    <circle cx="7" cy="7" r="2" />
  </svg>
);

export { GearIcon, loadSettings as warmSettings };

let opener: (() => void) | null = null;
export const openSettings = () => opener?.();

// Hosts the dialog, which grows out of origin and shrinks back into it. Its code loads once the app is idle, so a click opens it in the same frame.
export function SettingsHost({ origin }: { origin: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Lite skips the warm-up; hover, focus or the click still load it.
    if (isLite()) return;
    const id = requestIdleCallback(() => void loadSettings(), { timeout: 5000 });
    return () => cancelIdleCallback(id);
  }, []);
  useEffect(() => {
    opener = () => {
      if (Settings) setOpen(true);
      else void loadSettings().then(() => Settings && setOpen(true));
    };
    return () => {
      opener = null;
    };
  }, []);
  return open && Settings && createPortal(<Settings origin={origin} onClose={() => setOpen(false)} />, document.body);
}

// Covers the app while nothing can run a session: neither Claude nor Codex is signed in.
export function ConnectGate() {
  const ready = useSetup(isReady);
  if (ready) return null;
  return <Suspense fallback={null}><Connect /></Suspense>;
}
