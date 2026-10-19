import { create } from 'zustand';
import { DEFAULT_STYLES, type Summary } from './style.ts';
import type { ToolId } from './tool.ts';

// Eraser radius in CSS px, so the eraser feels the same at any zoom. Here, not in eraser.ts, so the store imports no tool.
export const ERASER_DEFAULT = 12;

// The refine job as the chip shows it: running with its step text, waiting on the changed-drawing choice, or failed.
export type JobUi = { phase: 'running' | 'stale' | 'failed'; text: string };

// Board UI state only (toolbar). Points, elements and the camera live in the engine, outside React.
type BoardUi = {
  tool: ToolId;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  // Eraser radius in CSS px.
  eraser: number;
  selection: boolean;
  // The selection's style, set with the selection.
  selStyle: Summary | null;
  // Style for the next stroke, shape and text.
  next: typeof DEFAULT_STYLES;
  canPaste: boolean;
  // Refine field text; cleared on submit.
  prompt: string;
  // Esc closed the refine field for the current selection.
  refineClosed: boolean;
  job: JobUi | null;
  // A short message shown in place of the hint line (a paste that failed).
  notice: string | null;
};

export const useBoard = create<BoardUi>(() => ({
  tool: 'pencil', canUndo: false, canRedo: false, zoom: 1, eraser: ERASER_DEFAULT, selection: false, selStyle: null,
  next: DEFAULT_STYLES, canPaste: false, prompt: '', refineClosed: false, job: null, notice: null,
}));

const NOTICE_MS = 4000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export function notice(text: string) {
  clearTimeout(noticeTimer);
  useBoard.setState({ notice: text });
  noticeTimer = setTimeout(() => useBoard.setState({ notice: null }), NOTICE_MS);
}
