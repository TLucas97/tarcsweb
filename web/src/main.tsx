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
connect();
createRoot(document.getElementById('root')!).render(<App />);
