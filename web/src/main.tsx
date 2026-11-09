import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect } from './socket.ts';
import { markStale } from './Stale.tsx';
import './theme.ts';
import './prefs.ts';
import './folderOpen.ts';
import './styles.css';

// Not prevented: the import still rejects, so the nearest ChunkGuard can draw its fallback.
window.addEventListener('vite:preloadError', markStale);
// Linux pastes the primary selection on middle-button release; the middle button only pans or toggles the lens here.
let middle = false;
addEventListener('pointerdown', (e) => { if (e.button === 1) middle = true; }, true);
addEventListener('pointerup', (e) => { if (e.button === 1) setTimeout(() => (middle = false)); }, true);
addEventListener('paste', (e) => { if (middle) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
connect();
createRoot(document.getElementById('root')!).render(<App />);
