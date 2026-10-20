import { Fragment, useEffect, useEffectEvent, useRef } from 'react';
import { BoardEngine } from './engine.ts';
import { detachJobs } from './refineJob.ts';
import { Refine, SendButton } from './Refine.tsx';
import { useBoard } from './store.ts';
import { StylePanel } from './StylePanel.tsx';
import { TOOL_ORDER, type ToolId } from './tool.ts';

const icon = (d: string) => () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PencilIcon = icon('M10.6 2.6l2.8 2.8-7.9 7.9H2.7v-2.8zM9 4.2l2.8 2.8');
const SelectIcon = icon('M3.5 2.5l9 4.2-3.9 1.4-1.4 3.9z');
const EraserIcon = icon('M6.2 13.5h7.3M8.9 3.3a1.4 1.4 0 0 1 2 0l2.3 2.3a1.4 1.4 0 0 1 0 2l-5.9 5.9H5.9l-2.6-2.6a1.4 1.4 0 0 1 0-2zM5.6 6.6l4.3 4.3');
const LassoIcon = icon('M8 2.5c3.2 0 5.5 1.6 5.5 3.7S11.2 9.9 8 9.9 2.5 8.3 2.5 6.2 4.8 2.5 8 2.5zM4.6 9.1c-1 .9-1.1 2.1-.3 2.8.8.8 2.2.6 2.2 1.6');
const TextIcon = icon('M3.5 4V3h9v1M8 3v10M6.2 13h3.6');
const CopyIcon =icon('M5.5 5.5V3.2c0-.4.3-.7.7-.7h6.6c.4 0 .7.3.7.7v6.6c0 .4-.3.7-.7.7h-2.3M3.2 5.5h6.6c.4 0 .7.3.7.7v6.6c0 .4-.3.7-.7.7H3.2a.7.7 0 0 1-.7-.7V6.2c0-.4.3-.7.7-.7z');
const PasteIcon = icon('M6 2.5h4v2H6zM10 3.5h1.8c.4 0 .7.3.7.7v8.6c0 .4-.3.7-.7.7H4.2a.7.7 0 0 1-.7-.7V4.2c0-.4.3-.7.7-.7H6');
const TrashIcon = icon('M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.3c0 .4.4.7.8.7h5c.4 0 .8-.3.8-.7l.7-8.3');
const AutoSelectIcon = icon('M2.5 2.5l6.5 3-2.8 1-1 2.8zM13.5 10.5a3 3 0 1 1-1-2.2M12.8 6.3v2h-2');

const RectIcon = icon('M3 4h10v8H3z');
const EllipseIcon = icon('M8 3.5c3 0 5.5 2 5.5 4.5S11 12.5 8 12.5 2.5 10.5 2.5 8 5 3.5 8 3.5z');
const LineIcon = icon('M3.5 12.5l9-9');
const ArrowIcon = icon('M3 12.5c1.2-4.6 4.4-7.8 9.5-9M8.6 3.2l3.9.3-.9 3.8');

const TOOLS: Record<ToolId, { label: string; key: string; Icon: () => React.JSX.Element }> = {
  pencil: { label: 'Pencil', key: 'P', Icon: PencilIcon },
  select: { label: 'Select', key: 'V', Icon: SelectIcon },
  eraser: { label: 'Eraser', key: 'E', Icon: EraserIcon },
  lasso: { label: 'Lasso', key: 'L', Icon: LassoIcon },
  text: { label: 'Text', key: 'T', Icon: TextIcon },
  rect: { label: 'Rectangle', key: 'R', Icon: RectIcon },
  ellipse: { label: 'Ellipse', key: 'O', Icon: EllipseIcon },
  line: { label: 'Line', key: 'I', Icon: LineIcon },
  arrow: { label: 'Arrow', key: 'A', Icon: ArrowIcon },
};
const BOX_HINT = 'Drag to draw · Shift for a square or circle · Alt to draw from the center · Enter or double-click a shape to type in it';

// Eraser radius presets in CSS px; [ and ] step between them and beyond.
const ERASER_SIZES = [
  { px: 6, label: 'Small' },
  { px: 12, label: 'Medium' },
  { px: 24, label: 'Large' },
];

const HINTS: Record<ToolId, string> = {
  pencil: 'Hold still at the end of a stroke to snap it to a shape · Paste or drop an image · Keys 1-9 pick tools in toolbar order',
  select: 'Click to select · Shift+click to add · Drag on empty space to select an area · Delete to remove · Enter types in a selected shape, else refines',
  eraser: '[ ] eraser size · Wheel to zoom · Space or middle-drag to pan',
  lasso: 'Draw around any part to select it, even half a stroke · Drag inside the selection to move · Delete to remove · Enter to refine',
  text: 'Click to add text, or click text to edit it · Esc or click outside to finish',
  rect: BOX_HINT,
  ellipse: BOX_HINT,
  line: 'Drag to draw · Shift for 45° steps · Alt to draw from the center',
  arrow: 'Drag along any path and the arrow follows it · Shift for a straight arrow in 45° steps',
};
const UndoIcon = icon('M5.5 3.5 2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7');
const RedoIcon = icon('M10.5 3.5l3 3-3 3M13.5 6.5h-7a4 4 0 0 0 0 8H9');
const MinusIcon = icon('M3.5 8h9');
const PlusIcon = icon('M3.5 8h9M8 3.5v9');
const CloseIcon = icon('M4 4l8 8M12 4l-8 8');

// Buttons never take focus from the board, so Space keeps panning instead of pressing the last clicked button.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function Toolbar({ eng }: { eng: React.RefObject<BoardEngine | null> }) {
  const tool = useBoard((s) => s.tool);
  const canUndo = useBoard((s) => s.canUndo);
  const canRedo = useBoard((s) => s.canRedo);
  const zoom = useBoard((s) => s.zoom);
  const eraser = useBoard((s) => s.eraser);
  const selection = useBoard((s) => s.selection);
  const canPaste = useBoard((s) => s.canPaste);
  const autoSelect = useBoard((s) => s.autoSelect);
  return (
    <div className="bd-bar" role="toolbar" aria-label="Board tools" onMouseDown={keepFocus}>
      {TOOL_ORDER.map((id, i) => {
        const { label, key, Icon } = TOOLS[id];
        return (
          <Fragment key={id}>
            {id === 'rect' && <span className="bd-vr" />}
            <button type="button" className="bd-btn bd-tool" aria-pressed={tool === id} aria-label={label} aria-keyshortcuts={`${i + 1} ${key}`} title={`${label} · ${i + 1} or ${key}`} onClick={() => eng.current?.setTool(id)}>
              <Icon />
              <span className="bd-num" aria-hidden="true">{i + 1}</span>
            </button>
          </Fragment>
        );
      })}
      <span className="bd-vr" />
      <button
        type="button"
        className="bd-btn"
        aria-pressed={autoSelect}
        aria-label="Switch to Select after drawing"
        title={`Switch to Select after a shape or text: ${autoSelect ? 'on' : 'off'}`}
        onClick={() => useBoard.setState({ autoSelect: !autoSelect })}
      >
        <AutoSelectIcon />
      </button>
      <span className="bd-vr" />
      {tool === 'eraser' && (
        <>
          {ERASER_SIZES.map(({ px, label }) => (
            <button key={px} type="button" className="bd-btn" aria-pressed={eraser === px} aria-label={`${label} eraser`} title={`${label} eraser ([ / ])`} onClick={() => eng.current?.setEraserSize(px)}>
              <span className="bd-dot" style={{ width: px / 2 + 3, height: px / 2 + 3 }} />
            </button>
          ))}
          <span className="bd-vr" />
        </>
      )}
      {(tool === 'lasso' || tool === 'select') && (
        <>
          <button type="button" className="bd-btn" disabled={!selection} aria-label="Copy selection" title="Copy (Ctrl+C)" onClick={() => eng.current?.copy()}>
            <CopyIcon />
          </button>
          <button type="button" className="bd-btn" disabled={!canPaste} aria-label="Paste" title="Paste (Ctrl+V)" onClick={() => eng.current?.paste()}>
            <PasteIcon />
          </button>
          <button type="button" className="bd-btn" disabled={!selection} aria-label="Delete selection" title="Delete (Del)" onClick={() => eng.current?.deleteSelection()}>
            <TrashIcon />
          </button>
          <span className="bd-vr" />
        </>
      )}
      <button type="button" className="bd-btn" disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)" onClick={() => eng.current?.undo()}>
        <UndoIcon />
      </button>
      <button type="button" className="bd-btn" disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={() => eng.current?.redo()}>
        <RedoIcon />
      </button>
      <span className="bd-vr" />
      <button type="button" className="bd-btn" aria-label="Zoom out" title="Zoom out" onClick={() => eng.current?.zoomBy(0.8)}>
        <MinusIcon />
      </button>
      <button type="button" className="bd-btn bd-zoom" aria-label="Reset zoom" title="Reset zoom to 100%" onClick={() => eng.current?.resetZoom()}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className="bd-btn" aria-label="Zoom in" title="Zoom in" onClick={() => eng.current?.zoomBy(1.25)}>
        <PlusIcon />
      </button>
    </div>
  );
}

// The drawing board, full window. The engine owns canvases and input; React renders only the toolbar around them.
export default function Board({ onClose }: { onClose?: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const eng = useRef<BoardEngine | null>(null);
  const close = useEffectEvent(() => onClose?.());
  useEffect(() => {
    const e = new BoardEngine({ root: rootRef.current!, scene: sceneRef.current!, live: liveRef.current!, onClose: () => close() });
    eng.current = e;
    return () => {
      detachJobs(e);
      e.dispose();
      eng.current = null;
    };
  }, []);
  return (
    <div className="bd-board" ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Drawing board">
      <canvas className="bd-cv" ref={sceneRef} aria-hidden="true" />
      <canvas className="bd-cv bd-live" ref={liveRef} aria-label="Drawing area" />
      <Toolbar eng={eng} />
      <StylePanel eng={eng} />
      <SendButton eng={eng} scope="board" className="bd-sendall" />
      {onClose && (
        <button type="button" className="bd-btn bd-close" aria-label="Close board" title="Close (Esc)" onMouseDown={keepFocus} onClick={onClose}>
          <CloseIcon />
        </button>
      )}
      <Refine eng={eng} root={rootRef} />
      <Hint />
    </div>
  );
}

function Hint() {
  const tool = useBoard((s) => s.tool);
  const notice = useBoard((s) => s.notice);
  return (
    <p className="bd-hint" data-notice={notice ? '' : undefined} role={notice ? 'status' : undefined}>
      {notice ?? HINTS[tool]}
    </p>
  );
}
