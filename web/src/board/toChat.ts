import { sendImage } from '../SendToChat.tsx';
import type { BoardEngine } from './engine.ts';
import { elementsPng } from './overview.ts';

// Pictures for the chat, cropped to their content: the selection (a lasso keeps just the part it cut) or the whole board.

export type Scope = 'selection' | 'board';

const NAMES: Record<Scope, string> = { selection: 'board-selection.png', board: 'board.png' };
const EMPTY: Record<Scope, string> = { selection: 'Nothing selected', board: 'The board is empty' };
const MAX_PX = 1600;
const PAD = 32;

// board.html runs without the app, so there is no composer to send to.
export const hasComposer = !location.pathname.endsWith('board.html');

function snapshot(eng: BoardEngine, scope: Scope) {
  const els = scope === 'board' ? eng.scene.order : eng.selection()?.inside;
  return els ? elementsPng(els, { maxPx: MAX_PX, maxScale: 2, pad: PAD }) : null;
}

// Adds the picture to the composer tray; returns an error to show, or null.
export async function sendPicture(eng: BoardEngine, scope: Scope): Promise<string | null> {
  const snap = await snapshot(eng, scope);
  if (!snap) return EMPTY[scope];
  const url = URL.createObjectURL(snap.blob);
  try {
    return await sendImage(url, NAMES[scope]);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadPicture(eng: BoardEngine, scope: Scope): Promise<string | null> {
  const snap = await snapshot(eng, scope);
  if (!snap) return EMPTY[scope];
  const url = URL.createObjectURL(snap.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = NAMES[scope];
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
