import { useCallback, useLayoutEffect, useRef } from 'react';
import { reduceMotion } from '../bits.tsx';
import { watchNear } from '../near.ts';

// Strong ease-out for entrances (same curve as --out); ease-in-out cubic for drawing along a path.
export const EASE_OUT = 'cubic-bezier(.23,1,.32,1)';
export const EASE_DRAW = 'cubic-bezier(.65,0,.35,1)';

// Builds a component's entrance from its rendered DOM. Must be a stable, module-level function.
export type Stage = (root: HTMLElement) => Animation[];

type Els = ArrayLike<Element> | Iterable<Element>;
export type Timing = { delay?: number | ((el: Element, i: number) => number); stagger?: number; duration?: number; easing?: string };

// `backwards` fill only: the last keyframe is the element's own style, so nothing stays held after the run.
function each(els: Els, frames: Keyframe[], t: Timing = {}) {
  return Array.from(els as ArrayLike<Element>, (el, i) => {
    const d = typeof t.delay === 'function' ? t.delay(el, i) : (t.delay ?? 0) + i * (t.stagger ?? 0);
    return el.animate(frames, { duration: t.duration ?? 360, delay: d, easing: t.easing ?? EASE_OUT, fill: 'backwards' });
  });
}

export const fade = (els: Els, t?: Timing) => each(els, [{ opacity: 0 }, { opacity: 1 }], t);
export const rise = (els: Els, t?: Timing, dy = 6) => each(els, [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'none' }], t);
// Bars grow from their baseline; set transform-origin on the element to the baseline side.
export const grow = (els: Els, axis: 'X' | 'Y', t?: Timing) => each(els, [{ transform: `scale${axis}(0)` }, { transform: 'none' }], t);
export const pop = (els: Els, t?: Timing, from = 0.5) => each(els, [{ opacity: 0, transform: `scale(${from})` }, { opacity: 1, transform: 'none' }], t);
// Set while a block of a streaming message builds its entrance: main-thread effects (draw, count) are skipped.
let lite = false;

// Paths need pathLength="1".
export const draw = (els: Els, t?: Timing) =>
  lite ? [] : each(els, [{ strokeDasharray: '1 2', strokeDashoffset: 1.02 }, { strokeDasharray: '1 2', strokeDashoffset: 0 }], { easing: EASE_DRAW, ...t });

// Count-up: a keyframe-less animation supplies eased progress, a per-frame writer turns it into text.
const writers = new WeakMap<Animation, () => void>();
const NUM = /^(\D*?)([-+−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\D*)$/;
export function counter(s: string): ((p: number) => string) | null {
  const m = NUM.exec(s.trim());
  if (!m) return null;
  const [, pre, sign, int, dec = '', suf] = m;
  const grouped = int.includes(',');
  const n = Number(int.replace(/,/g, '') + dec);
  // Zero has nothing to count; a bare year counting up from 0 reads as noise.
  if (!n || (!pre && !suf && !dec && !grouped && /^(19|20)\d\d$/.test(int))) return null;
  const places = Math.max(0, dec.length - 1);
  return (p) => {
    const v = (n * p).toFixed(places);
    const [i, f] = v.split('.');
    return `${pre}${sign}${grouped ? Number(i).toLocaleString('en-US') : i}${f ? `.${f}` : ''}${suf}`;
  };
}
export function count(els: Els, t?: Timing) {
  const out: Animation[] = [];
  if (lite) return out;
  Array.from(els as ArrayLike<Element>).forEach((el, i) => {
    const node = el.firstChild;
    const final = node?.nodeValue ?? '';
    const f = counter(final);
    if (!node || !f) return;
    const [a] = each([el], [], { duration: 720, ...t, delay: typeof t?.delay === 'function' ? t.delay(el, i) : (t?.delay ?? 0) + i * (t?.stagger ?? 0) });
    writers.set(a, () => {
      const p = a.effect?.getComputedTiming().progress;
      node.nodeValue = p == null || p >= 1 ? final : f(p);
    });
    out.push(a);
  });
  return out;
}

// When each block started its entrance (performance.now), keyed by source; survives remounts and session switches.
const begun = new Map<string, number>();
const BEGUN_MAX = 500;
function markBegun(key: string) {
  begun.delete(key);
  begun.set(key, performance.now());
  if (begun.size > BEGUN_MAX) begun.delete(begun.keys().next().value!);
}
// Longer than any entrance: a block begun before this rests in its final state, nothing to build.
const SETTLED = 6000;

// One viewport observer plays every entrance; it looks blocks up by element so it holds none.
const watching = new WeakMap<Element, Entrance>();
let seenIo: IntersectionObserver | null = null;
const seenObserver = () =>
  (seenIo ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || (e.intersectionRatio < 0.35 && e.intersectionRect.height < 160)) continue;
      watching.get(e.target)?.seen();
    }
  }, { threshold: [0, 0.35, 0.7] }));

class Entrance {
  anims: Animation[] = [];
  raf = 0;
  live = false;
  unwatch: (() => void) | null = null;
  readonly root: HTMLElement;
  readonly key: string;
  readonly stage: Stage;
  constructor(root: HTMLElement, key: string, stage: Stage) {
    this.root = root;
    this.key = key;
    this.stage = stage;
  }

  private build() {
    lite = this.live;
    try {
      this.anims = this.stage(this.root);
    } finally {
      lite = false;
    }
    delete this.root.dataset.pre;
  }

  private unobserve() {
    this.unwatch?.();
    this.unwatch = null;
    if (watching.get(this.root) !== this) return;
    watching.delete(this.root);
    seenIo?.unobserve(this.root);
  }

  private tick = () => {
    let live = false;
    for (const a of this.anims) {
      const w = writers.get(a);
      if (!w) continue;
      w();
      if (a.playState === 'running') live = true;
    }
    this.raf = live ? requestAnimationFrame(this.tick) : 0;
  };

  private stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const a of this.anims) a.cancel();
    this.anims = [];
  }

  private start(at: number) {
    this.stop();
    this.build();
    for (const a of this.anims) a.currentTime = at;
    this.tick();
  }

  mount() {
    if (reduceMotion()) return;
    const t0 = begun.get(this.key);
    if (t0 !== undefined && performance.now() - t0 > SETTLED) return;
    // The body waits hidden until its entrance exists, so a block mounted in view never flashes.
    if (t0 === undefined) this.root.dataset.pre = '';
    this.unwatch = watchNear(this.root, () => this.near(), '400px 0px');
  }

  // Built only near the viewport. Seen before: a remount mid-entrance resumes where it was.
  private near() {
    this.unwatch?.();
    this.unwatch = null;
    const t0 = begun.get(this.key);
    if (t0 !== undefined) return this.start(performance.now() - t0);
    this.build();
    for (const a of this.anims) (a.pause(), (a.currentTime = 0));
    this.tick();
    watching.set(this.root, this);
    seenObserver().observe(this.root);
  }

  seen() {
    this.unobserve();
    markBegun(this.key);
    for (const a of this.anims) a.play();
    this.tick();
  }

  replay() {
    this.unobserve();
    delete this.root.dataset.pre;
    if (reduceMotion()) {
      this.stop();
      const body = this.root.querySelector('.ub-body');
      if (body) this.anims = [body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease' })];
      return;
    }
    markBegun(this.key);
    this.start(0);
  }

  dispose() {
    this.unobserve();
    this.stop();
  }
}

// Runs `stage` once per block: when it first scrolls into view, or resumed after a remount.
// `live`: the message still streams, so the entrance skips main-thread effects.
export function useEntrance<E extends HTMLElement>(key: string, stage: Stage, live = false) {
  const ref = useRef<E>(null);
  const ctl = useRef<Entrance | null>(null);
  useLayoutEffect(() => {
    const e = new Entrance(ref.current!, key, stage);
    ctl.current = e;
    e.mount();
    return () => {
      e.dispose();
      if (ctl.current === e) ctl.current = null;
    };
  }, [key, stage]);
  useLayoutEffect(() => {
    if (ctl.current) ctl.current.live = live;
  }, [live, key, stage]);
  const replay = useCallback(() => ctl.current?.replay(), []);
  return { ref, replay };
}
