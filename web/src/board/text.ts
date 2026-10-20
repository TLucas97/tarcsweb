import { newId } from './pencil.ts';
import { colorOf } from './render.ts';
import { fitLabel, FONT, FONT_MAX, hitTest, labelWidth, LINE_HEIGHT, makeText, measureText, shape, TEXT_MAX } from './shapes.ts';
import { useBoard } from './store.ts';
import type { Tool, ToolHost } from './tool.ts';
import { INK, type Ellipse, type Pt, type Rect, type Text } from './types.ts';

const HIT_TOL = 4;

type EditorHost = Pick<ToolHost, 'scene' | 'cam' | 'edit' | 'record' | 'palette'> & {
  root: HTMLElement;
  // A label edit ended with this shape in the scene.
  labeled(el: Rect | Ellipse): void;
};

// One DOM textarea placed over the canvas in world space while typing. An edited element leaves the scene
// until commit, so the canvas never shows it twice.
export class TextEditor {
  private host: EditorHost;
  private ta: HTMLTextAreaElement | null = null;
  private orig: Text | null = null;
  // Label editing: the shape as it was, and as the scene holds it meanwhile (without its label).
  private box: { orig: Rect | Ellipse; bare: Rect | Ellipse } | null = null;
  private at: Pt = { x: 0, y: 0 };
  private font = 20;
  private color = INK;

  constructor(host: EditorHost) {
    this.host = host;
  }

  get active() {
    return !!this.ta;
  }

  open(target: Text | Pt) {
    this.commit();
    const { cam } = this.host;
    if ('kind' in target) {
      this.orig = target;
      this.font = target.fontSize;
      this.color = target.color;
      this.at = { x: target.x, y: target.y };
      this.host.edit({ before: [target], after: [] });
    } else {
      this.color = useBoard.getState().next.text.color;
      this.font = this.nextFont();
      // The click lands on the middle of the first line.
      this.at = { x: target.x, y: target.y - (this.font * LINE_HEIGHT) / 2 };
    }
    this.mount(this.orig?.text ?? '');
  }

  // Types into a rect or ellipse: the text wraps to its width and stays centered in it.
  openLabel(el: Rect | Ellipse) {
    this.commit();
    const { label: _, ...rest } = el;
    const bare = shape<Rect | Ellipse>(rest);
    this.box = { orig: el, bare };
    this.font = el.label?.fontSize ?? this.nextFont();
    this.color = el.color;
    this.host.edit({ before: [el], after: [bare] });
    this.mount(el.label?.text ?? '');
  }

  private nextFont() {
    return Math.min(FONT_MAX, Math.round((useBoard.getState().next.text.font / this.host.cam.z) * 10) / 10);
  }

  private mount(value: string) {
    const ta = document.createElement('textarea');
    ta.className = this.box ? 'bd-text bd-label' : 'bd-text';
    ta.spellcheck = false;
    ta.wrap = this.box ? 'soft' : 'off';
    ta.maxLength = TEXT_MAX;
    ta.setAttribute('aria-label', this.box ? 'Shape text' : 'Text');
    ta.value = value;
    ta.addEventListener('input', this.fit);
    ta.addEventListener('blur', this.onBlur);
    ta.addEventListener('keydown', this.onKey);
    this.ta = ta;
    this.host.root.appendChild(ta);
    this.sync();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // Follows the camera: called on every zoom or pan while open.
  sync() {
    const ta = this.ta;
    if (!ta) return;
    const { cam } = this.host;
    ta.style.font = `${this.font * cam.z}px/${LINE_HEIGHT} ${FONT}`;
    ta.style.color = colorOf(this.color, this.host.palette());
    if (this.box) ta.style.width = `${labelWidth(this.box.bare) * cam.z}px`;
    else {
      // A detached label keeps its centered lines and turn while edited.
      const rot = this.orig?.rot ?? 0;
      ta.style.textAlign = this.orig?.align ?? '';
      ta.style.transformOrigin = rot ? '50% 50%' : '';
      ta.style.transform = `translate(${(this.at.x - cam.x) * cam.z}px, ${(this.at.y - cam.y) * cam.z}px)${rot ? ` rotate(${rot}rad)` : ''}`;
    }
    this.fit();
  }

  // Returns the text element left in the scene, or null (label edit, or emptied text).
  commit(): Text | null {
    const ta = this.ta;
    if (!ta) return null;
    this.ta = null;
    ta.removeEventListener('blur', this.onBlur);
    if (document.activeElement === ta) this.host.root.focus({ preventScroll: true });
    ta.remove();
    if (this.box) {
      this.commitLabel(ta.value.replace(/\s+$/, ''));
      return null;
    }
    const orig = this.orig;
    this.orig = null;
    const text = ta.value.replace(/\s+$/, '');
    if (!text.trim()) {
      if (orig) this.host.record({ before: [orig], after: [] });
      return null;
    }
    if (orig && text === orig.text) {
      this.host.edit({ before: [], after: [orig] });
      return orig;
    }
    const { scene } = this.host;
    let at = this.at;
    // Centered or turned text keeps its center as its size changes.
    if (orig && (orig.align || orig.rot)) {
      const m = measureText(text, this.font);
      at = { x: orig.x + (orig.w - m.w) / 2, y: orig.y + (orig.h - m.h) / 2 };
    }
    const extra = { ...(orig?.role && { role: orig.role }), ...(orig?.align && { align: orig.align }), ...(orig?.rot && { rot: orig.rot }) };
    const el = makeText({ id: orig?.id ?? newId(), z: orig?.z ?? scene.nextZ(), x: at.x, y: at.y, text, fontSize: this.font, color: this.color, ...extra });
    this.host.edit({ before: [], after: [el] });
    this.host.record({ before: orig ? [orig] : [], after: [el] });
    return el;
  }

  // An emptied label removes it; a label taller than the shape grows the shape.
  private commitLabel(text: string) {
    const { orig, bare } = this.box!;
    this.box = null;
    let next: Rect | Ellipse = orig;
    if (text !== (orig.label?.text ?? '')) next = text.trim() ? fitLabel(shape<Rect | Ellipse>({ ...bare, label: { text, fontSize: this.font } })) : bare;
    this.host.edit({ before: [bare], after: [next] });
    if (next !== orig) this.host.record({ before: [orig], after: [next] });
    this.host.labeled(next);
  }

  private fit = () => {
    const ta = this.ta;
    if (!ta) return;
    if (this.box) {
      // Width is fixed by the shape; the block stays centered on it, turned with it.
      const { cam } = this.host, el = this.box.bare;
      ta.style.height = '0';
      const h = ta.scrollHeight, w = labelWidth(el) * cam.z;
      ta.style.height = `${h}px`;
      const cx = (el.x + el.w / 2 - cam.x) * cam.z, cy = (el.y + el.h / 2 - cam.y) * cam.z;
      ta.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px) rotate(${el.rot}rad)`;
      return;
    }
    ta.style.width = ta.style.height = '0';
    ta.style.width = `${ta.scrollWidth + 2}px`;
    ta.style.height = `${ta.scrollHeight}px`;
  };

  private onBlur = () => this.commit();

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      e.stopPropagation();
      this.commit();
    }
  };
}

// Click to place text, or click a text element to edit it. A click while editing only commits.
export class TextTool implements Tool {
  readonly id = 'text';
  readonly busy = false;
  private host: ToolHost;
  private editor: TextEditor;

  constructor(host: ToolHost, editor: TextEditor) {
    this.host = host;
    this.editor = editor;
  }

  down(p: Pt, e: PointerEvent) {
    // Keeps the focus change of the compat mousedown from blurring the textarea this click opens.
    e.preventDefault();
    if (this.editor.active) return this.editor.commit();
    const hit = hitTest(this.host.scene, p, HIT_TOL / this.host.cam.z);
    this.editor.open(hit?.kind === 'text' ? hit : p);
  }

  move() {}
  up() {}
  cancel() {}
  drawLive() {}

  hover(p: Pt | null) {
    this.host.setCursor(p ? 'text' : null);
  }
}
