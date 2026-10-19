import { sendImage } from '../SendToChat.tsx';
import type { BoardEngine } from './engine.ts';
import { drawingPng } from './overview.ts';

// The selection as a picture for the chat: the whole drawing, with what was selected framed in the accent color.

const NAME = 'board-selection.png';
const MAX_PX = 1600;
const PAD = 32;

// board.html runs without the app, so there is no composer to send to.
export const hasComposer = !location.pathname.endsWith('board.html');

function snapshot(eng: BoardEngine) {
  const region = eng.selection();
  return region ? drawingPng(eng.scene.order, region, { maxPx: MAX_PX, maxScale: 2, pad: PAD, frame: 'box' }) : null;
}

// Adds the picture to the composer tray; returns an error to show, or null.
export async function sendSelection(eng: BoardEngine): Promise<string | null> {
  const snap = await snapshot(eng);
  if (!snap) return 'Nothing selected';
  const url = URL.createObjectURL(snap.blob);
  try {
    return await sendImage(url, NAME);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadSelection(eng: BoardEngine): Promise<string | null> {
  const snap = await snapshot(eng);
  if (!snap) return 'Nothing selected';
  const url = URL.createObjectURL(snap.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = NAME;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
