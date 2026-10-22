import type { CursorShape } from '../../../server/protocol.ts';
import { ambient } from '../perf.ts';

type Meta = { w: number; h: number };
type Point = { x: number; y: number };

const EASE = 'cubic-bezier(.23,1,.32,1)';
const TRAVEL_MS = 200;
const IDLE_MS = 1500;

// Where an agent moved or pressed the mouse, drawn over the stage in the page's cursor shape. Moves with transform only; nothing runs between
// agent events, and it fades out after IDLE_MS without one.
export class AgentCursor {
  private el: HTMLElement;
  private next: Point | null = null;
  private shape: CursorShape = 'arrow';
  private shapeT = 0;
  private press = false;
  private at: Point | null = null;
  private travel: Animation | null = null;
  private landAt = 0;
  private f = 0;
  private idle = 0;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  point(kind: 'move' | 'down', x: number, y: number, shape: CursorShape, canvas: HTMLCanvasElement | null, meta: Meta) {
    this.next = { x, y };
    this.shape = shape;
    if (kind === 'down') this.press = true;
    this.f ||= requestAnimationFrame(() => this.draw(canvas, meta));
  }

  // Page CSS px to stage px, the inverse of the panel's input mapping (letterboxed object-fit: contain).
  private draw(canvas: HTMLCanvasElement | null, m: Meta) {
    this.f = 0;
    const p = this.next;
    const stage = this.el.parentElement;
    this.next = null;
    if (!p || !canvas || !stage || !m.w || !m.h) return;
    const r = canvas.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const k = Math.min(r.width / m.w, r.height / m.h);
    if (!k) return;
    const to = { x: Math.round(r.left - s.left + (r.width - m.w * k) / 2 + p.x * k), y: Math.round(r.top - s.top + (r.height - m.h * k) / 2 + p.y * k) };
    const calm = ambient();
    const now = performance.now();
    const css = `translate3d(${to.x}px,${to.y}px,0)`;
    // A hidden cursor appears in place; a shown one travels from wherever it is now, even mid-travel.
    if (this.at && !calm && (to.x !== this.at.x || to.y !== this.at.y)) {
      const from = getComputedStyle(this.el).transform;
      this.travel?.cancel();
      this.travel = this.el.animate([{ transform: from }, { transform: css }], { duration: TRAVEL_MS, easing: EASE });
      this.landAt = now + TRAVEL_MS;
    } else if (!this.at) {
      this.travel?.cancel();
      this.landAt = 0;
    }
    this.el.style.transform = css;
    this.at = to;
    // The shape switches on landing, like a real pointer reaching a link.
    const shape = this.shape;
    const wait = Math.max(0, this.landAt - now);
    clearTimeout(this.shapeT);
    if (wait) this.shapeT = window.setTimeout(() => (this.el.dataset.shape = shape), wait);
    else this.el.dataset.shape = shape;
    if (this.press) this.pulse(calm, wait, shape);
    this.press = false;
    this.el.classList.add('on');
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => this.hide(), IDLE_MS);
  }

  // Plays once the cursor lands. Starts at .9 scale, never from nothing; reduced motion and Lite keep only the fade.
  private pulse(calm: boolean, delay: number, shape: CursorShape) {
    const ring = this.el.querySelector('i');
    const glyph = this.el.querySelector(`svg.${shape}`);
    ring?.animate(calm ? [{ opacity: 0.6 }, { opacity: 0 }] : [{ transform: 'scale(.9)', opacity: 0.7 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: calm ? 300 : 450, delay, easing: EASE });
    if (!calm) glyph?.animate([{ transform: 'scale(.9)' }, { transform: 'none' }], { duration: 160, delay, easing: EASE });
  }

  hide() {
    cancelAnimationFrame(this.f);
    clearTimeout(this.idle);
    clearTimeout(this.shapeT);
    this.f = 0;
    this.next = null;
    this.press = false;
    this.at = null;
    this.el.classList.remove('on');
  }
}
