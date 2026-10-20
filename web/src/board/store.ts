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
  // A finished shape or text switches to the select tool with it selected.
  autoSelect: boolean;
};

// Styles, eraser size and the auto-select toggle survive reloads.
const PREFS_KEY = 'cw:board-prefs';
type Prefs = Pick<BoardUi, 'next' | 'eraser' | 'autoSelect'>;

function loadPrefs(): Prefs {
  let p: Partial<Prefs> = {};
  try {
    p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
  } catch {}
  const next = { ...DEFAULT_STYLES };
  for (const g of Object.keys(next) as (keyof typeof next)[]) next[g] = { ...next[g], ...p.next?.[g] };
  return { next, eraser: typeof p.eraser === 'number' ? p.eraser : ERASER_DEFAULT, autoSelect: p.autoSelect ?? true };
}

export const useBoard = create<BoardUi>(() => ({
  tool: 'pencil', canUndo: false, canRedo: false, zoom: 1, selection: false, selStyle: null,
  canPaste: false, prompt: '', refineClosed: false, job: null, notice: null, ...loadPrefs(),
}));

useBoard.subscribe((s, p) => {
  if (s.next === p.next && s.eraser === p.eraser && s.autoSelect === p.autoSelect) return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ next: s.next, eraser: s.eraser, autoSelect: s.autoSelect }));
  } catch {}
});

const NOTICE_MS = 4000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export function notice(text: string) {
  clearTimeout(noticeTimer);
  useBoard.setState({ notice: text });
  noticeTimer = setTimeout(() => useBoard.setState({ notice: null }), NOTICE_MS);
}
