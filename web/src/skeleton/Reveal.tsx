import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { heavy } from '../perf.ts';
import type { Shape } from './shapes.ts';

// Measured skeleton and sweep reveal, after skullet (github.com/lochie/skullet, MIT). CSS is the "skl-" section of styles.css.
const SLANT = (20 * Math.PI) / 180;
const COS = Math.cos(SLANT);
const TAN = Math.tan(SLANT);
const ANGLE = '110deg';
const STEPS = 12;
const PEAK = 0.85;
// ms per px of shimmer, so the stream keeps one speed on any width.
const PACE = (4000 * 0.7) / (1280 + 320);
const FEATHER = 40;
const PAD = FEATHER / COS;
const GLOSS = 320;
const GLOSS_LAG = 120;
// A load under HOLD never shows the skeleton; SEEN is HOLD plus the 200ms fade-in in styles.css.
const HOLD = 150;
const SEEN = 350;
const INPUT_QUIET = 400;
const MEDIA = 'img,svg,video,canvas,input,select,textarea,iframe';
// A reveal this short crossfades whole instead of sweeping.
const SMALL = 72;
// A frame over LATE ms missed its slot. That many late frames in one sweep drop the gloss, then the sweep itself.
const LATE = 24;
const GLOSS_OFF = 2;
const SWEEP_OFF = 4;
// What this machine has shown it can run: 2 sweep with gloss, 1 sweep alone, 0 crossfade.
let tier = 2;

const ease = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;

// One shared listener: content never moves under someone who is scrolling or typing.
let lastInput = -Infinity;
for (const type of ['wheel', 'touchmove', 'keydown']) {
  addEventListener(type, () => void (lastInput = performance.now()), { passive: true, capture: true });
}

type Bone = { x: number; y: number; w: number; h: number; r: string };
type Box = { l: number; t: number; r: number; b: number };

// One bar per line of text (ascender to descender, from the font's own metrics), one block per media element or painted chip.
function measure(ghost: HTMLElement, origin: DOMRect): Bone[] {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const fonts = new Map<string, { ascent: number; descent: number; up: number; down: number }>();
  const clips = new Map<Element, Box>();
  const out: Bone[] = [];
  const range = document.createRange();

  const clip = (el: Element): Box => {
    if (el === ghost) return { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    let c = clips.get(el);
    if (c) return c;
    c = clip(el.parentElement!);
    if (getComputedStyle(el).overflow !== 'visible') {
      const r = el.getBoundingClientRect();
      c = { l: Math.max(c.l, r.left), t: Math.max(c.t, r.top), r: Math.min(c.r, r.right), b: Math.min(c.b, r.bottom) };
    }
    clips.set(el, c);
    return c;
  };
  // Clipped to overflow ancestors; slivers under 2px (visually hidden labels) are dropped.
  const add = (el: Element, l: number, t: number, r: number, b: number, radius: string) => {
    const c = clip(el);
    const x = Math.max(l, c.l), y = Math.max(t, c.t);
    const w = Math.min(r, c.r) - x, h = Math.min(b, c.b) - y;
    if (w < 2 || h < 2) return null;
    const bone = { x: x - origin.left, y: y - origin.top, w, h, r: radius };
    out.push(bone);
    return bone;
  };
  const labels = (el: Element) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n = 0;
    while (n < 2 && w.nextNode()) if ((w.currentNode as Text).data.trim()) n++;
    return n;
  };
  const text = (node: Text, el: Element) => {
    const style = getComputedStyle(el);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    let m = fonts.get(font);
    if (!m) {
      ctx.font = font;
      const box = ctx.measureText('H');
      m = { ascent: box.fontBoundingBoxAscent, descent: box.fontBoundingBoxDescent, up: ctx.measureText('bdfhkl').actualBoundingBoxAscent, down: ctx.measureText('gjpqy').actualBoundingBoxDescent };
      fonts.set(font, m);
    }
    range.setStart(node, node.data.search(/\S/));
    range.setEnd(node, node.data.trimEnd().length);
    const gap = parseFloat(style.fontSize) * 0.4;
    let prev: Bone | null = null;
    for (const r of range.getClientRects()) {
      const base = r.top + (r.height - m.ascent - m.descent) / 2 + m.ascent;
      const top = base - m.up, bottom = base + m.down;
      const left = r.left - origin.left;
      // Fragments of one line read as one bar.
      if (prev && Math.abs(prev.y - (top - origin.top)) < prev.h / 2 && left - (prev.x + prev.w) <= gap) {
        prev.w = Math.max(prev.w, left + r.width - prev.x);
        continue;
      }
      prev = add(el, r.left, top, r.right, bottom, `${Math.round((bottom - top) / 3)}px`);
    }
  };
  const walk = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    if (style.display === 'none') return;
    const painted = (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') || style.boxShadow !== 'none';
    const media = el.matches(MEDIA);
    if (media || (painted && labels(el) < 2)) {
      const r = el.getBoundingClientRect();
      if (add(el, r.left, r.top, r.right, r.bottom, style.borderRadius) && !media) el.style.visibility = 'hidden';
      return;
    }
    for (const n of el.childNodes) {
      if (n instanceof HTMLElement || n instanceof SVGElement) walk(n as HTMLElement);
      else if (n instanceof Text && n.data.trim()) text(n, el);
    }
  };
  for (const child of ghost.children) walk(child as HTMLElement);
  return out;
}

// Every bone shows its slice of one diagonal stream. The slice moves with transform, so the loop stays on the compositor.
function draw(layer: HTMLElement, bones: Bone[], origin: DOMRect) {
  const band = Math.min(Math.max(origin.width * 0.4, 80), 320);
  const period = band * 2.5;
  const tile = period / COS;
  const dur = tile * PACE;
  const stop = (at: number, alpha: number) => `color-mix(in srgb, var(--skl-hi) ${(alpha * 100).toFixed(1)}%, transparent) ${(at * band).toFixed(2)}px`;
  const stops: string[] = [];
  for (let i = 0; i <= STEPS; i++) stops.push(stop((i / STEPS) * PEAK, ease(i / STEPS)));
  for (let i = 1; i <= STEPS; i++) stops.push(stop(PEAK + (i / STEPS) * (1 - PEAK), ease(1 - i / STEPS)));
  const s = layer.style;
  s.setProperty('--skl-img', `repeating-linear-gradient(${ANGLE}, ${stops.join(', ')}, transparent ${period.toFixed(2)}px)`);
  s.setProperty('--skl-tile', `${tile}px`);
  s.setProperty('--skl-dur', `${dur}ms`);
  // A negative delay off the document clock keeps a late skeleton in phase with one already running.
  s.setProperty('--skl-delay', `${-(Number(document.timeline.currentTime ?? 0) % dur)}ms`);
  layer.replaceChildren(
    ...bones.map((b) => {
      const el = document.createElement('div');
      el.className = 'skl-bone';
      el.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border-radius:${b.r}`;
      const run = document.createElement('i');
      run.style.backgroundPosition = `${-(origin.left + scrollX + b.x + (origin.top + b.y) * TAN)}px 0`;
      el.append(run);
      return el;
    }),
  );
}

// 13 eased stops across the feather: the incoming pane shows behind the front, the outgoing one ahead of it.
const frontMask = (at: number, incoming: boolean) =>
  `linear-gradient(${ANGLE}, ${Array.from({ length: STEPS + 1 }, (_, i) => {
    const shown = incoming ? 1 - ease(i / STEPS) : ease(i / STEPS);
    return `rgb(0 0 0 / ${shown.toFixed(3)}) ${(at - FEATHER + (2 * FEATHER * i) / STEPS).toFixed(2)}px`;
  }).join(', ')})`;
const glossMask = (centre: number) =>
  `linear-gradient(${ANGLE}, ${Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS;
    return `rgb(0 0 0 / ${ease(1 - Math.abs(t * 2 - 1)).toFixed(3)}) ${(centre - GLOSS / 2 + GLOSS * t).toFixed(2)}px`;
  }).join(', ')})`;
const setMask = (el: HTMLElement, value: string) => {
  el.style.maskImage = value;
  el.style.webkitMaskImage = value;
};

// The gloss lifts the content toward white; on dark surfaces a full lift flashes, so it is lower there.
function liftFilter() {
  const k = document.documentElement.dataset.theme === 'dark' ? 0.18 : 0.45;
  const fn = `type="linear" slope="${1 - k}" intercept="${k}"`;
  const holder = document.createElement('div');
  holder.innerHTML = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="skl-lift" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR ${fn}/><feFuncG ${fn}/><feFuncB ${fn}/></feComponentTransfer></filter></svg>`;
  const svg = holder.firstElementChild!;
  document.body.append(svg);
  return svg;
}

// Measures the ghost into bones while `active`, again whenever its size or the fonts change.
function useBones(active: boolean, label: string) {
  const ghost = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const box = useRef({ since: 0, h: 0, leaving: false });
  const [said, setSaid] = useState('');

  useEffect(() => {
    if (!active) return;
    box.current = { since: performance.now(), h: 0, leaving: false };
    let raf = 0;
    const run = () => {
      raf = 0;
      const g = ghost.current, l = layer.current;
      if (!g || !l || box.current.leaving) return;
      const origin = l.getBoundingClientRect();
      box.current.h = origin.height;
      draw(l, measure(g, origin), origin);
    };
    const ask = () => void (raf ||= requestAnimationFrame(run));
    const ro = new ResizeObserver(ask);
    ro.observe(ghost.current!);
    void document.fonts.ready.then(ask);
    // Announced only when the wait is long enough to be noticed.
    const say = setTimeout(() => setSaid(label), HOLD);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(say);
    };
  }, [active, label]);

  return { ghost, layer, box, said, setSaid };
}

type Div = RefObject<HTMLDivElement | null>;
function Pane({ pane, ghost, layer, html, sample }: { pane?: Div; ghost: Div; layer: Div; html?: string | null; sample: ReactNode }) {
  return (
    <div className="skl-pane" ref={pane} aria-hidden="true" inert>
      {html ? <div className="skl-ghost" ref={ghost} dangerouslySetInnerHTML={{ __html: html }} /> : <div className="skl-ghost" ref={ghost}>{sample}</div>}
      <div className="skl-bones" ref={layer} />
    </div>
  );
}

// A skeleton with no handover: it stands where the content will be, and the caller swaps it out.
export function Skeleton({ label, sample }: { label: string; sample: ReactNode }) {
  const { ghost, layer, said } = useBones(true, label);
  return (
    <div className="skl" aria-busy="true">
      <span className="sr" role="status">{said}</span>
      <Pane ghost={ghost} layer={layer} sample={sample} />
    </div>
  );
}

type Props = { ready: boolean; label: string; done: string; sample: ReactNode; shape?: Shape; sweep?: boolean; children: ReactNode };

// Shows a skeleton shaped like the content until `ready`, then hands over to the children.
// The skeleton takes the shape remembered in `shape`, else `sample`. `sweep={false}` hands over with a crossfade.
export function Reveal({ ready, label, done, sample, shape, sweep = true, children }: Props) {
  const [gone, setGone] = useState(ready);
  const [html, setHtml] = useState(() => (ready ? null : shape?.read() ?? null));
  // Loading again after a reveal brings the skeleton back.
  if (!ready && gone) {
    setGone(false);
    setHtml(shape?.read() ?? null);
  }
  const { ghost, layer, box, said, setSaid } = useBones(!ready, label);
  const inner = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!ready || gone) return;
    const p = pane.current!, c = inner.current!;
    const waited = performance.now() - box.current.since;
    box.current.leaving = true;
    // The skeleton leaves the flow at its last measured box and the content takes its place.
    p.style.cssText = `position:absolute;inset:0 0 auto;height:${box.current.h}px`;
    let raf = 0, timer = 0, over = false;
    let gloss: HTMLElement | null = null, filter: Element | null = null;
    const end = () => {
      if (over) return;
      over = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      gloss?.remove();
      filter?.remove();
      setMask(c, '');
      shape?.write(c);
      setSaid(done);
      setGone(true);
    };
    const fade = (ms: number) => {
      c.animate({ opacity: [0, 1] }, { duration: ms, easing: 'ease' });
      p.animate({ opacity: 0 }, { duration: ms, easing: 'ease', fill: 'forwards' }).onfinish = end;
    };
    if (waited < HOLD || performance.now() - lastInput < INPUT_QUIET) end();
    else if (waited < SEEN) fade(120);
    else if (!sweep || heavy() || tier === 0) fade(200);
    else {
      setMask(c, 'linear-gradient(transparent, transparent)');
      let start = 0, last = 0, span = 0, dur = 0, late = 0;
      const crossfade = (now: number) => {
        const progress = Math.min((now - start) / dur, 1);
        p.style.display = 'none';
        c.animate({ opacity: [progress, 1] }, { duration: 200 * (1 - progress), easing: 'ease' });
        end();
      };
      const tick = (now: number) => {
        // The first frame only prepares; the clock starts on the next one, so setup never reads as a stall.
        if (!span) {
          const b = c.getBoundingClientRect();
          if (import.meta.env.DEV && Math.abs(b.height - box.current.h) > 1) console.warn(`[skeleton] "${label}" was ${box.current.h}px tall, its content is ${b.height}px`);
          if (b.height < SMALL) {
            setMask(c, '');
            return fade(200);
          }
          // Only the part on screen is swept, so a long list does not slow the front down.
          span = b.width + Math.max(Math.min(b.bottom, innerHeight) - b.top, 0) * TAN;
          const speed = Math.max(2 / PACE, span / 360);
          dur = (span + 2 * PAD) / speed;
          if (tier === 2 && !matchMedia('(prefers-reduced-transparency: reduce)').matches) {
            filter = liftFilter();
            gloss = c.cloneNode(true) as HTMLElement;
            gloss.className = 'skl-gloss';
            gloss.inert = true;
            gloss.setAttribute('aria-hidden', 'true');
            c.after(gloss);
          }
          // Ends the wipe even if frames stop coming.
          timer = window.setTimeout(end, dur + (GLOSS + GLOSS_LAG) / speed + 200);
          raf = requestAnimationFrame(tick);
          return;
        }
        if (!start) start = last = now;
        // Frames dropped: finish as a crossfade from where the front got.
        if (now - last > 100) return crossfade(now);
        // A machine that cannot keep up loses the gloss first, then the sweep, for the rest of this page load.
        if (now - last > LATE) late++;
        if (late >= SWEEP_OFF) {
          tier = 0;
          return crossfade(now);
        }
        if (late >= GLOSS_OFF && gloss) {
          tier = 1;
          gloss.remove();
          filter?.remove();
          gloss = filter = null;
        }
        last = now;
        const progress = (now - start) / dur;
        const at = (-PAD + (span + 2 * PAD) * progress) * COS;
        if (progress < 1) {
          setMask(c, frontMask(at, true));
          setMask(p, frontMask(at, false));
        } else {
          setMask(c, '');
          p.style.display = 'none';
        }
        const centre = at - GLOSS_LAG;
        if (!gloss ? progress >= 1 : centre - GLOSS / 2 > span * COS) return end();
        if (gloss) setMask(gloss, glossMask(centre));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    return end;
  }, [ready, gone, shape, label, done, sweep, box, setSaid]);

  return (
    <div className="skl" aria-busy={!ready || undefined}>
      <span className="sr" role="status">{said}</span>
      {ready && <div ref={inner}>{children}</div>}
      {!gone && <Pane pane={pane} ghost={ghost} layer={layer} html={html} sample={sample} />}
    </div>
  );
}
