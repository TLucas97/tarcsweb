import type { Camera } from './camera.ts';
import type { Change } from './history.ts';
import type { Palette } from './render.ts';
import type { Scene } from './scene.ts';
import type { Box, El, Pt } from './types.ts';

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';
export type ToolId = 'pencil' | 'select' | 'eraser' | 'lasso' | 'text' | ShapeKind;
export const isShapeKind = (id: string): id is ShapeKind => id === 'rect' || id === 'ellipse' || id === 'line' || id === 'arrow';
// Toolbar order; number keys 1-9 pick by position.
export const TOOL_ORDER: readonly ToolId[] = ['pencil', 'select', 'eraser', 'lasso', 'text', 'rect', 'ellipse', 'line', 'arrow'];
export type Cursor = 'move' | 'ew' | 'ns' | 'nwse' | 'nesw' | 'text';

// What a tool may touch.
export type ToolHost = {
  scene: Scene;
  cam: Camera;
  palette(): Palette;
  // The visible world rect.
  view(): Box;
  // Applies one gesture's change to the scene and history, and paints it in the same task.
  commit(c: Change): void;
  // Live edit during a gesture: changes the scene without history and repaints only `box` (default: the touched bboxes).
  edit(c: Change, box?: Box): void;
  // Pushes a gesture already applied through edit() as one history entry.
  record(c: Change): void;
  // Schedules a scene repaint of one world rect.
  repaint(box: Box): void;
  // Schedules one overlay repaint; `full` clears and redraws it instead of adding to it.
  paintLive(full?: boolean): void;
  clearLive(): void;
  setCursor(c: Cursor | null): void;
  // Modifier keys held now; pointer and key events keep them current.
  mods(): { shift: boolean; alt: boolean };
  // A drawing tool made `el`: the board switches to the select tool with it selected.
  made(el: El): void;
};

// A pointer gesture in world coordinates. The engine owns pan, zoom and capture; a tool sees only its own drags.
export interface Tool {
  readonly id: ToolId;
  readonly busy: boolean;
  down(p: Pt, e: PointerEvent): void;
  move(pts: readonly Pt[]): void;
  up(): void;
  cancel(): void;
  // Draws onto the overlay, whose context already carries the camera transform.
  drawLive(ctx: CanvasRenderingContext2D, full: boolean): void;
  // Pointer over the canvas with no button down; null when it leaves.
  hover?(p: Pt | null): void;
  // Keys the tool handles while idle (Delete, copy, paste). True when handled.
  key?(e: KeyboardEvent): boolean;
  // Esc while idle; true when the tool used it (e.g. to clear a selection) instead of letting the board close.
  escape?(): boolean;
  // During a gesture, draws an element the tool is changing without touching the scene; true when it did.
  paintEl?(ctx: CanvasRenderingContext2D, el: El, view: Box): boolean;
  // Drops state tied to the current scene; called on tool switch and before undo or redo.
  reset?(): void;
  // Shift or Alt changed during a gesture.
  refresh?(): void;
}
