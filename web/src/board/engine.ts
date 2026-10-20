import { pushEscape } from '../escape.ts';
import { Camera } from './camera.ts';
import { cutRegion } from './cut.ts';
import { fromJSON, toJSON, type Exported, type Parsed } from './elements.ts';
import { Eraser, ERASER_MAX, ERASER_MIN } from './eraser.ts';
import { PolyMask, round2, union } from './geom.ts';
import { History, type Change } from './history.ts';
import { imageFile, loadImage } from './images.ts';
import { boardCopyNewer, clipboardHoldsBoard, clipboardLeft, Lasso, type Region } from './lasso.ts';
import { newId, Pencil } from './pencil.ts';
import { drawEl, drawScene, type Palette } from './render.ts';
import { Scene } from './scene.ts';
import { ShapeTool } from './shapeTool.ts';
import { canLabel, clearWraps, FONT_MAX, hitTest, makeText, measureText, shape, TEXT_MAX } from './shapes.ts';
import { notice, useBoard } from './store.ts';
import { restyle, STYLE_GROUP, type StylePatch } from './style.ts';
import { TextEditor, TextTool } from './text.ts';
import { TOOL_ORDER, type Cursor, type Tool, type ToolHost, type ToolId } from './tool.ts';
import type { Box, El, Ellipse, Img, Pt, Rect } from './types.ts';

const SCENE = 1;
const LIVE = 2;
const LIVE_FULL = 4;
// Repaint only `region` of the scene.
const REGION = 8;
// Only re-place pinned DOM controls.
const PINS = 16;
// Gap between a pinned control and its box or the window edge, in CSS px.
const PIN_GAP = 8;

const ERASER_STEP = 1.25;
const TOOL_KEYS: Record<string, ToolId> = { p: 'pencil', v: 'select', e: 'eraser', l: 'lasso', t: 'text', r: 'rect', o: 'ellipse', i: 'line', a: 'arrow' };
const keyTool = (e: KeyboardEvent): ToolId | undefined => TOOL_KEYS[e.key.toLowerCase()] ?? (/^[1-9]$/.test(e.key) ? TOOL_ORDER[+e.key - 1] : undefined);
// Double-click reach onto a text element, in CSS px.
const TEXT_HIT = 4;
// Largest share of the view's width or height a new picture takes.
const IMAGE_FIT = 0.6;

// Wheel delta (px) per zoom doubling; one mouse notch is clamped so it never jumps more than ~15-20%.
const WHEEL_ZOOM = 300;
const PINCH_ZOOM = 200;
const WHEEL_CLAMP = 60;
const BUTTON_ZOOM = 1.25;

// The drawing outlives the overlay: closing and reopening the board in the same page keeps it.
const doc = { scene: new Scene(), history: new History(), cam: new Camera() };

type Els = { root: HTMLElement; scene: HTMLCanvasElement; live: HTMLCanvasElement; onClose: () => void };
// A DOM control kept next to a world box; w and h come from a ResizeObserver, `at` is the transform last written.
type Pin = { el: HTMLElement; box: () => Box | null; w: number; h: number; at: string };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

const editable = (t: EventTarget | null) => t instanceof Element && !!t.closest('input,textarea,select,[contenteditable]');
// A button focused from the keyboard keeps Space and Enter to press itself; other board keys still work.
const pressesButton = (e: KeyboardEvent) => (e.key === ' ' || e.key === 'Enter') && e.target instanceof Element && !!e.target.closest('button');

// Owns the two canvases, input and frame scheduling. At most one rAF is pending, and only while something changed.
export class BoardEngine implements ToolHost {
  readonly scene = doc.scene;
  readonly cam = doc.cam;
  private history = doc.history;
  private el: Els;
  private sctx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private dirty = 0;
  private region: Box | null = null;
  private raf = 0;
  private eraser: Eraser;
  private lasso: Lasso;
  private picker: Lasso;
  private editor: TextEditor;
  private tools: Record<ToolId, Tool>;
  private tool: Tool;
  private pal: Palette = { ink: '#2b2a27', grid: '#e8e4d9', accent: '#b7841f' };
  private pointer = -1;
  private pan: { id: number; x: number; y: number } | null = null;
  private space = false;
  private keys = { shift: false, alt: false };
  private origin = { x: 0, y: 0 };
  // Last hover position in client px, so a tool switch or camera move can refresh hover feedback.
  private hoverAt: { clientX: number; clientY: number } | null = null;
  private offs: (() => void)[] = [];
  private pins = new Set<Pin>();

  constructor(el: Els) {
    this.el = el;
    this.sctx = el.scene.getContext('2d')!;
    this.lctx = el.live.getContext('2d')!;
    this.eraser = new Eraser(this);
    this.lasso = new Lasso(this);
    this.picker = new Lasso(this, 'select');
    this.editor = new TextEditor({ scene: this.scene, cam: this.cam, edit: (c, b) => this.edit(c, b), record: (c) => this.record(c), palette: () => this.pal, root: el.root, labeled: (s) => this.labeled(s) });
    this.tools = {
      pencil: new Pencil(this), select: this.picker, eraser: this.eraser, lasso: this.lasso, text: new TextTool(this, this.editor),
      rect: new ShapeTool(this, 'rect'), ellipse: new ShapeTool(this, 'ellipse'), line: new ShapeTool(this, 'line'), arrow: new ShapeTool(this, 'arrow'),
    };
    const ui = useBoard.getState();
    this.tool = this.tools[ui.tool];
    el.root.dataset.tool = ui.tool;
    this.eraser.size = ui.eraser;
    this.readPalette();
    this.listen();
    useBoard.setState({ zoom: this.cam.z, canUndo: this.history.canUndo, canRedo: this.history.canRedo, selection: false, canPaste: this.lasso.canPaste });
    el.root.focus({ preventScroll: true });
  }

  dispose() {
    this.editor.commit();
    if (this.tool.busy) this.tool.cancel();
    this.tool.reset?.();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ToolHost

  palette() {
    return this.pal;
  }

  view() {
    return this.cam.view(this.w, this.h);
  }

  edit(c: Change, box?: Box) {
    this.scene.replace(c.before, c.after);
    let b = box ?? null;
    if (!b) for (const el of [...c.before, ...c.after]) b = b ? union(b, el.bbox) : el.bbox;
    if (b) this.repaint(b);
  }

  repaint(b: Box) {
    this.region = this.region ? union(this.region, b) : b;
    this.invalidate(REGION);
  }

  record(c: Change) {
    this.history.push(c);
    this.syncHistory();
    this.invalidate(SCENE);
  }

  setCursor(c: Cursor | null) {
    const root = this.el.root;
    if (c) root.dataset.cursor = c;
    else delete root.dataset.cursor;
  }

  mods() {
    return this.keys;
  }

  made(el: El) {
    if (!useBoard.getState().autoSelect) return;
    this.setTool('select');
    this.picker.select(el);
  }

  commit(c: Change) {
    const onTop = this.scene.replace(c.before, c.after);
    this.history.push(c);
    this.syncHistory();
    // Overlay clear and scene paint happen in the same task, so no frame shows the stroke missing.
    this.clearLive();
    if (onTop && !(this.dirty & SCENE)) {
      this.cam.apply(this.sctx, this.dpr);
      for (const el of c.after) drawEl(this.sctx, el, this.pal);
    } else this.invalidate(SCENE);
  }

  paintLive(full = false) {
    this.invalidate(full ? LIVE_FULL : LIVE);
  }

  clearLive() {
    this.dirty &= ~(LIVE | LIVE_FULL);
    this.lctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lctx.clearRect(0, 0, this.el.live.width, this.el.live.height);
  }

  // Toolbar actions

  undo() {
    this.editor.commit();
    if (this.tool.busy || !this.history.canUndo) return;
    this.dropSelection();
    const c = this.history.undo();
    if (c) this.applyChange(c);
  }

  redo() {
    this.editor.commit();
    if (this.tool.busy || !this.history.canRedo) return;
    this.dropSelection();
    const c = this.history.redo();
    if (c) this.applyChange(c);
  }

  setTool(id: ToolId) {
    this.editor.commit();
    if (id === this.tool.id) return;
    if (this.tool.busy) {
      this.pointer = -1;
      this.tool.cancel();
    }
    this.tool.hover?.(null);
    this.tool.reset?.();
    this.tool = this.tools[id];
    this.el.root.dataset.tool = id;
    useBoard.setState({ tool: id });
    this.clearLive();
    this.refreshHover();
  }

  // With a selection, restyles what it holds as one undo step; without one, sets the active tool's next style.
  applyStyle(patch: StylePatch) {
    if (this.tool.busy) return;
    const sel = this.editor.active ? null : this.selector;
    if (sel && useBoard.getState().selection) return sel.restyle((el) => restyle(el, patch));
    const group = STYLE_GROUP[this.tool.id];
    if (!group) return;
    const next = useBoard.getState().next;
    useBoard.setState({ next: { ...next, [group]: { ...next[group], ...patch } } });
  }

  setEraserSize(px: number) {
    const size = Math.round(Math.min(ERASER_MAX, Math.max(ERASER_MIN, px)));
    this.eraser.size = size;
    useBoard.setState({ eraser: size });
    if (this.tool === this.eraser) this.paintLive(true);
  }

  copy() {
    this.selector?.copy();
  }

  // Into the selecting tool in use, else the select tool.
  paste() {
    this.editor.commit();
    if (!this.lasso.canPaste || this.tool.busy) return;
    if (!this.selector) this.setTool('select');
    this.selector?.paste();
  }

  deleteSelection() {
    this.editor.commit();
    if (!this.tool.busy) this.selector?.remove();
  }

  // The current tool when it is one that selects (lasso or select).
  private get selector(): Lasso | null {
    return this.tool === this.lasso || this.tool === this.picker ? (this.tool as Lasso) : null;
  }

  // A gesture or a text edit is in progress; their changes are not in the scene yet.
  get busy() {
    return this.tool.busy || this.editor.active;
  }

  get revision() {
    return this.scene.rev;
  }

  // The selection's world bounds while it is at rest, or null.
  selectionBox(): Box | null {
    return !this.editor.active ? (this.selector?.bounds() ?? null) : null;
  }

  // Keeps a DOM control next to a world box (below it, above when there is no room), hidden while `box` is null.
  pin(el: HTMLElement, box: () => Box | null) {
    const p: Pin = { el, box, w: 0, h: 0, at: '' };
    const ro = new ResizeObserver(([e]) => {
      const b = e.borderBoxSize?.[0];
      p.w = b ? b.inlineSize : e.contentRect.width;
      p.h = b ? b.blockSize : e.contentRect.height;
      this.invalidate(PINS);
    });
    ro.observe(el);
    this.pins.add(p);
    this.invalidate(PINS);
    return () => {
      ro.disconnect();
      this.pins.delete(p);
    };
  }

  // The current selection as data, or null without one.
  selection(): Region | null {
    return this.selector?.region() ?? null;
  }

  // Elements JSON for a region (default: the current selection).
  toJSON(region: Region | null = this.selection()): Exported {
    return region ? toJSON(region) : { ok: false, error: 'Nothing selected' };
  }

  // Validates elements JSON and builds elements fitted into `target`, without touching the board.
  fromJSON(json: unknown, target: Box): Parsed {
    return fromJSON(json, target, () => this.scene.nextZ());
  }

  // Swaps what a region holds for `els` as one undo step, with the same scope toJSON exported: a clicked
  // selection is just its elements; a lasso is cut fresh, strokes at the edge and shapes more than half inside.
  replaceRegion(region: Region | readonly number[], els: readonly El[]) {
    this.editor.commit();
    if (this.tool.busy) return false;
    let c: { touched: El[]; outside: El[] };
    if ('only' in region && region.only) {
      const touched = region.only.map((id) => this.scene.byId.get(id)).filter((el): el is El => !!el);
      c = { touched, outside: [] };
    } else c = cutRegion(this.scene, new PolyMask('poly' in region ? region.poly : region));
    this.dropSelection();
    if (c.touched.length || els.length) this.commit({ before: c.touched, after: [...c.outside, ...els] });
    this.paintLive(true);
    return true;
  }

  // fromJSON fitted to `target` (default: the region's box), then replaceRegion; bad JSON changes nothing.
  replaceRegionJSON(region: Region, json: unknown, target: Box = region.bbox): Parsed {
    const r = this.fromJSON(json, target);
    if (r.ok && !this.replaceRegion(region, r.elements)) return { ok: false, error: 'Board is busy' };
    return r;
  }

  zoomBy(f: number) {
    this.zoomTo(this.cam.z * f, this.w / 2, this.h / 2);
  }

  resetZoom() {
    this.zoomTo(1, this.w / 2, this.h / 2);
  }

  // Internals

  // Text bounds follow the loaded font: elements whose measure changed are replaced in place, outside history.
  private remeasure() {
    if (!this.offs.length) return;
    const stale: El[] = [], fresh: El[] = [];
    clearWraps();
    for (const el of this.scene.order) {
      if (canLabel(el) && el.label) {
        const n = shape(el), a = n.bbox, b = el.bbox;
        if (a.x0 !== b.x0 || a.y0 !== b.y0 || a.x1 !== b.x1 || a.y1 !== b.y1) stale.push(el), fresh.push(n);
        continue;
      }
      if (el.kind !== 'text') continue;
      const m = measureText(el.text, el.fontSize);
      if (m.w === el.w && m.h === el.h) continue;
      stale.push(el);
      fresh.push(makeText(el));
    }
    if (stale.length) {
      this.scene.replace(stale, fresh);
      if (!this.tool.busy) this.dropSelection();
    }
    this.invalidate(SCENE | LIVE_FULL);
  }

  private applyChange(c: Change) {
    this.scene.replace(c.before, c.after);
    this.syncHistory();
    this.invalidate(SCENE);
  }

  private dropSelection() {
    if (!this.selector || !useBoard.getState().selection) return;
    this.selector.clear();
  }

  private refreshHover() {
    if (this.hoverAt && !this.tool.busy && this.pointer === -1) this.tool.hover?.(this.world(this.hoverAt));
  }

  private syncHistory() {
    useBoard.setState({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
  }

  private zoomTo(z: number, sx: number, sy: number) {
    if (!this.cam.zoomAt(sx, sy, z)) return;
    useBoard.setState({ zoom: this.cam.z });
    this.cameraMoved();
  }

  private cameraMoved() {
    // The overlay always redraws: a selection or the eraser circle may be showing while no gesture runs.
    this.invalidate(SCENE | LIVE_FULL);
    this.refreshHover();
    this.editor.sync();
  }

  private invalidate(bits: number) {
    this.dirty |= bits;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    const d = this.dirty;
    this.dirty = 0;
    if (d & SCENE) this.paintScene();
    else if (d & REGION && this.region) this.paintRegion(this.region);
    this.region = null;
    if (d & (LIVE | LIVE_FULL)) this.paintLiveNow(!!(d & LIVE_FULL));
    if (this.pins.size) this.placePins();
  };

  // Writes styles only when a pin's spot changed; sizes come from the observer, so no layout is read here.
  private placePins() {
    const { x, y, z } = this.cam;
    for (const p of this.pins) {
      const b = p.box();
      let at = '';
      if (b && p.w) {
        const below = (b.y1 - y) * z + PIN_GAP, above = (b.y0 - y) * z - PIN_GAP - p.h;
        const top = below + p.h <= this.h - PIN_GAP || above < PIN_GAP ? below : above;
        at = `translate(${Math.round(clamp((b.x0 - x) * z, PIN_GAP, this.w - p.w - PIN_GAP))}px,${Math.round(clamp(top, PIN_GAP, this.h - p.h - PIN_GAP))}px)`;
      }
      if (at === p.at) continue;
      p.at = at;
      if (at) p.el.style.transform = at;
      p.el.style.visibility = at ? 'visible' : 'hidden';
    }
  }

  private paintScene() {
    const c = this.sctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.el.scene.width, this.el.scene.height);
    this.cam.apply(c, this.dpr);
    const view = this.cam.view(this.w, this.h);
    drawScene(c, this.scene.order, view, this.cam.z, this.pal, this.override(c, view));
  }

  // Redraws one world rect, snapped out to whole device pixels so clipped edges leave no seams.
  private paintRegion(b: Box) {
    const c = this.sctx, cv = this.el.scene, k = this.cam.z * this.dpr;
    const x0 = Math.max(0, Math.floor((b.x0 - this.cam.x) * k) - 1), y0 = Math.max(0, Math.floor((b.y0 - this.cam.y) * k) - 1);
    const x1 = Math.min(cv.width, Math.ceil((b.x1 - this.cam.x) * k) + 1), y1 = Math.min(cv.height, Math.ceil((b.y1 - this.cam.y) * k) + 1);
    if (x1 <= x0 || y1 <= y0) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.save();
    c.beginPath();
    c.rect(x0, y0, x1 - x0, y1 - y0);
    c.clip();
    c.clearRect(x0, y0, x1 - x0, y1 - y0);
    this.cam.apply(c, this.dpr);
    const view = { x0: this.cam.x + x0 / k, y0: this.cam.y + y0 / k, x1: this.cam.x + x1 / k, y1: this.cam.y + y1 / k };
    drawScene(c, this.scene.order, view, this.cam.z, this.pal, this.override(c, view));
    c.restore();
  }

  private override(c: CanvasRenderingContext2D, view: Box) {
    const t = this.tool;
    return t.busy && t.paintEl ? (el: El) => t.paintEl!(c, el, view) : undefined;
  }

  private paintLiveNow(full: boolean) {
    if (full) this.clearLive();
    this.cam.apply(this.lctx, this.dpr);
    this.tool.drawLive(this.lctx, full);
  }

  // Resizing a canvas clears it, so both layers repaint right here, before the browser paints.
  private resize(cw: number, ch: number, pw: number, ph: number) {
    if (!cw || !ch) return;
    this.w = cw;
    this.h = ch;
    this.dpr = pw / cw;
    for (const cv of [this.el.scene, this.el.live]) {
      if (cv.width !== pw) cv.width = pw;
      if (cv.height !== ph) cv.height = ph;
    }
    this.dirty &= ~(SCENE | REGION);
    this.region = null;
    this.paintScene();
    this.paintLiveNow(true);
    if (this.pins.size) this.placePins();
    this.readOrigin();
  }

  private readPalette() {
    const cs = getComputedStyle(this.el.root);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    this.pal = {
      ink: v('--ink', this.pal.ink), grid: v('--line', this.pal.grid), accent: v('--coral', this.pal.accent),
      gray: v('--bd-gray', '#747168'), hue: v('--bd-hue', '#2f6bd0'), note: v('--bd-note', '#d4462e'),
    };
  }

  private world(e: { clientX: number; clientY: number }): Pt {
    return this.cam.toWorld(e.clientX - this.origin.x, e.clientY - this.origin.y);
  }

  private readOrigin() {
    const r = this.el.live.getBoundingClientRect();
    this.origin = { x: r.left, y: r.top };
  }

  private setPanCursor() {
    const root = this.el.root;
    if (this.pan) root.dataset.pan = 'active';
    else if (this.space) root.dataset.pan = 'ready';
    else delete root.dataset.pan;
  }

  private down = (e: PointerEvent) => {
    if (this.pan || this.tool.busy) return;
    const panning = e.button === 1 || (e.button === 0 && this.space);
    if (!panning && e.button !== 0) return;
    // A press while typing only finishes the text, before any tool sees the scene's stand-in for the edited element.
    if (!panning && this.editor.active) {
      e.preventDefault();
      const text = this.editor.commit();
      if (text && this.tool.id === 'text') this.made(text);
      return;
    }
    this.readOrigin();
    this.el.live.setPointerCapture(e.pointerId);
    if (panning) {
      e.preventDefault();
      this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.setPanCursor();
      return;
    }
    this.pointer = e.pointerId;
    this.keys = { shift: e.shiftKey, alt: e.altKey };
    this.tool.down(this.world(e), e);
  };

  // Shift and Alt as the last event saw them; a change mid-gesture redraws it (a rect turning square).
  private trackMods(e: { shiftKey: boolean; altKey: boolean }) {
    if (e.shiftKey === this.keys.shift && e.altKey === this.keys.alt) return;
    this.keys = { shift: e.shiftKey, alt: e.altKey };
    if (this.tool.busy) this.tool.refresh?.();
  }

  private move = (e: PointerEvent) => {
    const pan = this.pan;
    if (pan && e.pointerId === pan.id) {
      this.cam.panBy(e.clientX - pan.x, e.clientY - pan.y);
      pan.x = e.clientX;
      pan.y = e.clientY;
      this.cameraMoved();
      return;
    }
    if (this.pointer === -1 && !this.tool.busy && !pan) {
      this.hoverAt = { clientX: e.clientX, clientY: e.clientY };
      this.tool.hover?.(this.world(e));
      return;
    }
    if (e.pointerId !== this.pointer || !this.tool.busy) return;
    this.keys = { shift: e.shiftKey, alt: e.altKey };
    // Coalesced samples keep fast strokes round; not Baseline, so fall back to the event itself.
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    this.tool.move((list.length ? list : [e]).map((p) => this.world(p)));
  };

  private up = (e: PointerEvent) => {
    if (this.pan && e.pointerId === this.pan.id) {
      this.pan = null;
      this.setPanCursor();
      return;
    }
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    this.tool.up();
  };

  // Double-click edits a text element, or the label of a rect or ellipse, with the select, lasso or text tool.
  private dblclick = (e: MouseEvent) => {
    if (this.tool.busy || (!this.selector && this.tool.id !== 'text')) return;
    const hit = hitTest(this.scene, this.world(e), TEXT_HIT / this.cam.z);
    if (hit && canLabel(hit)) return this.editLabel(hit);
    if (hit?.kind !== 'text') return;
    this.dropSelection();
    this.paintLive(true);
    this.editor.open(hit);
  };

  // The one rect or ellipse selected whole, which Enter types into.
  private labelTarget(): Rect | Ellipse | null {
    const el = this.selector?.single();
    return el && canLabel(el) && this.scene.byId.get(el.id) === el ? el : null;
  }

  private editLabel(el: Rect | Ellipse) {
    this.dropSelection();
    this.paintLive(true);
    this.editor.openLabel(el);
  }

  // A finished label edit leaves its shape selected, so Enter edits it again.
  private labeled(el: Rect | Ellipse) {
    if (this.tool !== this.picker || this.tool.busy || this.scene.byId.get(el.id) !== el) return;
    this.picker.select(el);
  }

  private leave = () => {
    if (this.pointer !== -1 || this.tool.busy) return;
    this.hoverAt = null;
    this.tool.hover?.(null);
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.readOrigin();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.h : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    const sx = e.clientX - this.origin.x, sy = e.clientY - this.origin.y;
    const clamp = (v: number) => Math.max(-WHEEL_CLAMP, Math.min(WHEEL_CLAMP, v));
    // Ctrl+wheel is also what a trackpad pinch sends.
    if (e.ctrlKey || e.metaKey) return this.zoomTo(this.cam.z * 2 ** (-clamp(dy) / PINCH_ZOOM), sx, sy);
    if (e.shiftKey) {
      this.cam.panBy(-(dx || dy), 0);
      return this.cameraMoved();
    }
    // Trackpad scrolling has sideways or fractional deltas and pans; a mouse wheel's whole-number steps zoom.
    if (dx !== 0 || !Number.isInteger(dy)) {
      this.cam.panBy(-dx, -dy);
      return this.cameraMoved();
    }
    this.zoomTo(this.cam.z * 2 ** (-clamp(dy) / WHEEL_ZOOM), sx, sy);
  };

  // Esc peels one layer: the running gesture, then the tool's selection, then the board itself.
  private escape = () => {
    if (this.editor.active) this.editor.commit();
    else if (this.tool.busy) {
      this.pointer = -1;
      this.tool.cancel();
    } else if (!this.tool.escape?.() && !this.pan) this.el.onClose();
  };

  private key = (e: KeyboardEvent) => {
    const inBoard = e.target instanceof Node && this.el.root.contains(e.target);
    // The app's shortcuts (Alt+W, Ctrl+K...) must not act on the hidden app; keys inside the board are stopped at its root instead.
    if (!inBoard) e.stopImmediatePropagation();
    if (e.isComposing || (inBoard && (editable(e.target) || pressesButton(e)))) return;
    this.trackMods(e);
    const mod = e.ctrlKey || e.metaKey;
    const take = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (e.key === 'Escape') {
      take();
      this.escape();
    } else if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey && !this.tool.busy && this.labelTarget()) {
      take();
      this.editLabel(this.labelTarget()!);
    } else if (!this.tool.busy && this.tool.key?.(e)) {
      take();
    } else if (!mod && !e.altKey && !editable(e.target) && keyTool(e)) {
      take();
      this.setTool(keyTool(e)!);
    } else if (!mod && (e.key === '[' || e.key === ']')) {
      take();
      this.setEraserSize(e.key === '[' ? this.eraser.size / ERASER_STEP : this.eraser.size * ERASER_STEP);
    } else if (mod && e.code === 'KeyZ') {
      take();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.code === 'KeyY') {
      take();
      this.redo();
    } else if (mod && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
      take();
      if (e.key === '0') this.resetZoom();
      else this.zoomBy(e.key === '-' ? 1 / BUTTON_ZOOM : BUTTON_ZOOM);
    } else if (e.code === 'Space' && !mod) {
      take();
      if (!this.space) {
        this.space = true;
        this.setPanCursor();
      }
    }
  };

  // Ctrl+V lands here rather than in keydown, since only the paste event carries the system clipboard:
  // a picture there wins, unless the board copied since and could not replace it, else the board's own clipboard.
  // The board's own format never shows in a paste event, so an empty clipboard means our copy; text or a picture
  // copied elsewhere since wins over the board copy.
  private onPaste = (e: ClipboardEvent) => {
    if (editable(e.target)) return;
    const dt = e.clipboardData, own = this.lasso.canPaste;
    const take = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // The board-copy write failed, so the system clipboard still holds something older.
    if (own && boardCopyNewer()) return take(), this.paste();
    const file = imageFile(dt);
    if (file) return take(), void this.addImage(file, null);
    const text = dt?.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\s+$/, '') ?? '';
    if (text.trim()) return take(), this.addText(text);
    if (!own || dt?.types.length) return;
    take();
    void clipboardHoldsBoard().then((held) => held !== false && this.offs.length && this.paste());
  };

  // Pasted text becomes a text element at the view's center in the next-text style, selected.
  private addText(raw: string) {
    this.editor.commit();
    if (this.tool.busy) {
      this.pointer = -1;
      this.tool.cancel();
    }
    const st = useBoard.getState().next.text, text = raw.slice(0, TEXT_MAX);
    const fontSize = Math.min(FONT_MAX, Math.round((st.font / this.cam.z) * 10) / 10);
    const v = this.view(), m = measureText(text, fontSize);
    const el = makeText({ id: newId(), z: this.scene.nextZ(), x: round2((v.x0 + v.x1 - m.w) / 2), y: round2((v.y0 + v.y1 - m.h) / 2), text, fontSize, color: st.color });
    this.commit({ before: [], after: [el] });
    if (!this.selector) this.setTool('select');
    this.selector?.select(el);
  }

  private dragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    // Stopped here so the app's own drop zone underneath never reacts.
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragover') e.dataTransfer.dropEffect = 'copy';
  };

  private drop = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    const file = imageFile(e.dataTransfer);
    if (file) void this.addImage(file, { clientX: e.clientX, clientY: e.clientY });
    else notice('Only images can be dropped on the board');
  };

  // Decodes a picture and places it at `at` (client px) or the view's center, fit inside most of the view.
  async addImage(file: Blob, at: { clientX: number; clientY: number } | null) {
    // Read right before pruning, so images lifted by a drag that started meanwhile stay open.
    const keep = () => {
      const s = new Set<string>();
      for (const el of [...this.scene.order, ...this.history.elements(), ...this.lasso.held(), ...this.picker.held()]) if (el.kind === 'image') s.add(el.src);
      return s;
    };
    let img: { src: string; w: number; h: number };
    try {
      img = await loadImage(file, keep);
    } catch (e) {
      return notice((e as Error).message);
    }
    if (!this.offs.length) return;
    this.editor.commit();
    if (this.tool.busy) {
      this.pointer = -1;
      this.tool.cancel();
    }
    this.readOrigin();
    const v = this.view(), vw = v.x1 - v.x0, vh = v.y1 - v.y0;
    // Screen pixels at the device ratio, so a screenshot shows at its real size when it fits.
    const k = Math.min(1 / devicePixelRatio, (IMAGE_FIT * vw) / img.w, (IMAGE_FIT * vh) / img.h);
    const w = img.w * k, h = img.h * k;
    const c = at ? this.world(at) : { x: (v.x0 + v.x1) / 2, y: (v.y0 + v.y1) / 2 };
    const el = shape<Img>({ kind: 'image', id: newId(), z: this.scene.nextZ(), x: round2(c.x - w / 2), y: round2(c.y - h / 2), w: round2(w), h: round2(h), src: img.src });
    this.commit({ before: [], after: [el] });
    if (!this.selector) this.setTool('select');
    this.selector?.select(el);
  }

  private keyUp = (e: KeyboardEvent) => {
    this.trackMods(e);
    if (e.code !== 'Space' || !this.space) return;
    this.space = false;
    this.setPanCursor();
  };

  private listen() {
    const { root, live } = this.el;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.offs.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on(live, 'pointerdown', this.down);
    on(live, 'pointermove', this.move);
    on(live, 'pointerup', this.up);
    on(live, 'pointercancel', this.up);
    // A capture lost without pointerup (window blur, alert) still ends the gesture.
    on(live, 'lostpointercapture', this.up);
    on(live, 'pointerleave', this.leave);
    on(live, 'dblclick', this.dblclick);
    // Text measured or drawn before the web font loaded used a fallback face.
    const fonts = () => this.remeasure();
    document.fonts?.addEventListener('loadingdone', fonts);
    document.fonts?.ready.then(fonts);
    this.offs.push(() => document.fonts?.removeEventListener('loadingdone', fonts));
    // On the root, so zoom and pan also work over the text editor.
    on(root, 'wheel', this.wheel, { passive: false });
    // Middle-click would paste the primary selection on Linux or start autoscroll.
    const noMiddle = (e: MouseEvent) => e.button === 1 && e.preventDefault();
    on(live, 'mousedown', noMiddle);
    on(live, 'auxclick', noMiddle);
    // Ahead of the app's own shortcuts (Escape interrupts a turn there).
    addEventListener('keydown', this.key, true);
    on(root, 'keydown', (e) => e.stopPropagation());
    // On top of the app's Esc stack, so an open Find or viewer underneath never takes the board's Esc.
    this.offs.push(pushEscape(this.escape));
    addEventListener('keyup', this.keyUp, true);
    const blur = () => {
      this.keyUp(new KeyboardEvent('keyup', { code: 'Space' }));
      clipboardLeft();
    };
    addEventListener('blur', blur);
    addEventListener('paste', this.onPaste, true);
    this.offs.push(() => {
      removeEventListener('keydown', this.key, true);
      removeEventListener('keyup', this.keyUp, true);
      removeEventListener('blur', blur);
      removeEventListener('paste', this.onPaste, true);
    });
    on(root, 'dragenter', this.dragOver);
    on(root, 'dragover', this.dragOver);
    on(root, 'dragleave', this.dragOver);
    on(root, 'drop', this.drop);

    const ro = new ResizeObserver(([entry]) => {
      const css = entry.contentRect;
      const w = Math.round(css.width * devicePixelRatio), h = Math.round(css.height * devicePixelRatio);
      // Exact device pixels when the browser reports them; emulated pixel ratios (DevTools) report CSS pixels instead.
      const px = entry.devicePixelContentBoxSize?.[0];
      const exact = px && Math.abs(px.inlineSize - w) <= 1 && Math.abs(px.blockSize - h) <= 1;
      this.resize(css.width, css.height, exact ? px.inlineSize : w, exact ? px.blockSize : h);
    });
    this.offs.push(() => ro.disconnect());
    try {
      ro.observe(root, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(root);
      // Without device-pixel boxes, a pixel ratio change alone (browser zoom, other monitor) fires no resize.
      let mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      const onDpr = () => {
        mq.removeEventListener('change', onDpr);
        if (this.w) this.resize(this.w, this.h, Math.round(this.w * devicePixelRatio), Math.round(this.h * devicePixelRatio));
        mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
        mq.addEventListener('change', onDpr);
      };
      mq.addEventListener('change', onDpr);
      this.offs.push(() => mq.removeEventListener('change', onDpr));
    }

    const mo = new MutationObserver(() => {
      this.readPalette();
      this.invalidate(SCENE | LIVE_FULL);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.offs.push(() => mo.disconnect());
  }
}
