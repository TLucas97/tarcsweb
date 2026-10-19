import { createRoot } from 'react-dom/client';
import Board from './Board.tsx';
import '../styles.css';

// Dev-only page (web/board.html): the board alone, full window, without the app or its socket.
createRoot(document.getElementById('root')!).render(<Board />);
