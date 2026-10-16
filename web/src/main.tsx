import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect } from './socket.ts';
import './theme.ts';
import './prefs.ts';
import './styles.css';

connect();
createRoot(document.getElementById('root')!).render(<App />);
