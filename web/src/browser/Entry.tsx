import { Suspense, lazy, useEffect } from 'react';
import { useBrowserRun, watchBrowser } from './activity.ts';
import { toggleBrowser, useBrowserOpen } from './open.ts';

// The panel, its socket and its canvas load on the first open.
const BrowserPanel = lazy(() => import('./Panel.tsx'));

export const BrowserIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="7" cy="7" r="5.2" />
    <path d="M1.8 7h10.4M7 1.8c1.5 1.4 2.2 3.1 2.2 5.2S8.5 10.8 7 12.2M7 1.8C5.5 3.2 4.8 4.9 4.8 7s.7 3.8 2.2 5.2" />
  </svg>
);

const WHY = { panel: 'the panel is open', session: 'a session is using it', recording: 'a recording is running', idle: 'stops soon if unused' } as const;

export function BrowserTrigger() {
  const on = useBrowserOpen();
  const run = useBrowserRun();
  const live = run.status === 'live';
  const going = live || run.status === 'starting';
  const state = going ? `Chrome ${live ? 'is running' : 'is starting'}${run.why ? ` (${WHY[run.why]})` : ''}` : '';
  const agents = `agents ${run.agents ? 'on' : 'off'}`;
  return (
    <button
      type="button" className={`fnd-open brw-open${going ? ' run' : ''}`} title={`Browser · ${agents}${state ? ` · ${state}` : ''}`}
      aria-label={`Open the browser. Agents ${run.agents ? 'on' : 'off'}.${state ? ` ${state}` : ''}`} aria-pressed={on} onClick={(e) => toggleBrowser(e.currentTarget)}
    >
      <BrowserIcon />
      {going && <i className={`mcp-dot${live ? '' : ' wait'}`} aria-hidden="true"></i>}
    </button>
  );
}

// Mounted once in App; renders nothing until the panel opens or an agent uses the browser.
export function BrowserMount() {
  const on = useBrowserOpen();
  useEffect(() => watchBrowser(), []);
  if (!on) return null;
  return <Suspense fallback={null}><BrowserPanel /></Suspense>;
}
