import { useEffect, useRef } from 'react';
import { ambient } from './perf.ts';

// Split-flap text: a changed character falls through a few random glyphs, half by half, like a departures board.
const NOISE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rnd = () => NOISE[(Math.random() * NOISE.length) | 0];
// Gravity: the top half accelerates into the hinge, the bottom half lands.
const FALL = 'cubic-bezier(.55,0,1,.45)';
const LAND = 'cubic-bezier(0,.55,.45,1)';
const HALF = 58;

type Cell = { node: HTMLSpanElement; parts: HTMLElement[]; halves: HTMLElement[]; ch: string; target: string; hops: number; busy: boolean; onIdle?: () => void };

function cellNode(ch: string): Cell {
  const node = document.createElement('span');
  node.className = 'pfc';
  node.innerHTML = '<span class="pfh pt"><b></b></span><span class="pfh pb"><b></b></span><span class="pfh pft"><b></b><i></i></span><span class="pfh pfb"><b></b><i></i></span>';
  const halves = [...node.children] as HTMLElement[];
  const parts = halves.map((x) => x.firstElementChild as HTMLElement);
  for (const b of parts) b.textContent = ch;
  return { node, parts, halves, ch, target: ch, hops: 0, busy: false };
}

// The flapping half turns on its hinge while its shade (an overlay, so only opacity animates) darkens it.
function fold(half: HTMLElement, from: number, to: number, shade: [number, number], easing: string) {
  half.lastElementChild!.animate([{ opacity: shade[0] }, { opacity: shade[1] }], { duration: HALF, easing });
  return half.animate([{ transform: `rotateX(${from}deg)` }, { transform: `rotateX(${to}deg)` }], { duration: HALF, easing }).finished.catch(() => {});
}

async function flipOnce(c: Cell, next: string) {
  const [top, bot, ft, fb] = c.parts;
  const [, , FT, FB] = c.halves;
  const old = c.ch;
  top.textContent = next;
  bot.textContent = old;
  ft.textContent = old;
  fb.textContent = next;
  FT.style.display = 'block';
  await fold(FT, 0, -90, [0, 1], FALL);
  FT.style.display = '';
  FB.style.display = 'block';
  await fold(FB, 90, 0, [0.5, 0], LAND);
  bot.textContent = next;
  FB.style.display = '';
  c.ch = next;
}

async function run(c: Cell) {
  if (c.busy) return;
  c.busy = true;
  while (c.ch !== c.target && c.node.isConnected) await flipOnce(c, c.hops-- > 0 ? rnd() : c.target);
  c.busy = false;
  c.onIdle?.();
}

export type FlapOptions = { hops?: [number, number]; hold?: number };

// Imperative so a stream of changes never re-renders React; the hold keeps a fast burst of steps readable.
export class FlapRow {
  private cells: Cell[] = [];
  private final = '';
  private at = 0;
  private wait = 0;
  private timers = new Set<number>();
  private el: HTMLElement;
  private o: FlapOptions;
  constructor(el: HTMLElement, o: FlapOptions = {}) {
    this.el = el;
    this.o = o;
  }
  set(text: string, now = false) {
    this.final = text;
    clearTimeout(this.wait);
    // Lite and reduced motion swap the text with no flips.
    if (now || ambient()) return this.snap(text);
    const left = (this.o.hold ?? 0) - (performance.now() - this.at);
    if (left > 0 && this.at) this.wait = window.setTimeout(() => this.apply(text), left);
    else this.apply(text);
  }
  destroy() {
    clearTimeout(this.wait);
    for (const t of this.timers) clearTimeout(t);
  }
  private snap(text: string) {
    this.el.replaceChildren();
    this.cells = [...text].map((ch) => cellNode(ch));
    for (const c of this.cells) this.el.append(c.node);
  }
  private trim = () => {
    while (this.cells.length > this.final.length) {
      const c = this.cells[this.cells.length - 1];
      if (c.busy || c.ch !== ' ') break;
      this.cells.pop()!.node.remove();
    }
  };
  private apply(text: string) {
    this.at = performance.now();
    const [lo, hi] = this.o.hops ?? [1, 3];
    const n = Math.max(this.cells.length, text.length);
    // Long lines settle faster per cell, so the whole change stays near 300ms of stagger.
    const stagger = Math.min(14, 300 / Math.max(1, n));
    for (let i = 0; i < n; i++) {
      let c = this.cells[i];
      const ch = text[i] ?? ' ';
      if (!c) {
        c = cellNode(' ');
        this.cells[i] = c;
        this.el.append(c.node);
      }
      c.onIdle = this.trim;
      if (c.target === ch) continue;
      c.target = ch;
      c.hops = lo + ((Math.random() * (hi - lo + 1)) | 0);
      const cell = c;
      const t = window.setTimeout(() => {
        this.timers.delete(t);
        void run(cell);
      }, i * stagger);
      this.timers.add(t);
    }
    this.trim();
  }
}

// A span whose text flips on change. `tiles` draws each character on its own board tile.
export function Flap({ text, tiles = false, className = '', hops, hold }: { text: string; tiles?: boolean; className?: string } & FlapOptions) {
  const ref = useRef<HTMLSpanElement>(null);
  const row = useRef<FlapRow>(null);
  useEffect(() => {
    const r = new FlapRow(ref.current!, { hops, hold });
    r.set(text, true);
    row.current = r;
    return () => r.destroy();
    // Options are fixed for the life of the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    row.current?.set(text);
  }, [text]);
  // Each cell holds four copies of its glyph, so readers get the plain text instead.
  return (
    <>
      <span className="sr">{text}</span>
      <span ref={ref} className={`flaps${tiles ? ' tiles' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true" />
    </>
  );
}
