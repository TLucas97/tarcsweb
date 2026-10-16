import { clamp } from '../robot.tsx';
import type { WatchModel } from './model.ts';
import type { World } from './world.ts';

// Watch mode's scrubber: the session span on a small canvas, redrawn only when a tick would move a pixel.
// The playhead, the dimmed "ahead of you" span and the hover line are DOM layers moved by transform.

const PAD = 10;
const Y = 25;

export class Track {
  el: HTMLElement;
  t0 = 0;
  t1 = 1;
  w = 1;
  private h = 40;
  private left = 0;
  private dpr = 1;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private head: HTMLElement;
  private ahead: HTMLElement;
  private hov: HTMLElement;
  private tip: HTMLElement;
  private key = '';
  private headTf = '';
  private aheadTf = '';
  private tipText = '';

  constructor(el: HTMLElement) {
    this.el = el;
    this.cv = el.querySelector('canvas')!;
    this.g = this.cv.getContext('2d')!;
    this.head = el.querySelector('.wt-head')!;
    this.ahead = el.querySelector('.wt-ahead')!;
    this.hov = el.querySelector('.wt-hov')!;
    this.tip = el.querySelector('.wt-tip')!;
  }

  // From the track's ResizeObserver: size from contentRect, left read there so pointer handlers never touch layout.
  layout(w: number, h: number, left: number, dpr: number) {
    this.w = Math.max(1, w);
    this.h = h;
    this.left = left;
    this.dpr = dpr;
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.key = this.headTf = this.aheadTf = '';
  }

  invalidate() {
    this.key = '';
  }

  x(t: number) {
    return PAD + (this.w - 2 * PAD) * clamp((t - this.t0) / Math.max(1e-3, this.t1 - this.t0), 0, 1);
  }

  tAt(clientX: number) {
    return this.t0 + clamp((clientX - this.left - PAD) / Math.max(1, this.w - 2 * PAD), 0, 1) * (this.t1 - this.t0);
  }

  draw(m: WatchModel, wd: World, at: number) {
    // Redraw when the span grows enough to move the newest tick by about a pixel.
    const key = `${m.version}|${Math.round(Math.log(this.t1 - this.t0 + 1) * this.w)}|${at}|${this.w}|${wd.dark}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.g, P = wd.P, st = m.stations, n = m.routeLen;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const xo = Math.max(PAD, this.x(m.openT)), xl = this.x(this.t1);
    // Dashed: before watch opened on a synthetic clock, or earlier history not loaded yet.
    g.strokeStyle = P.line;
    g.lineWidth = 1.5;
    if (xo > PAD + 1) {
      g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(PAD, Y); g.lineTo(xo, Y); g.stroke();
      g.setLineDash([]);
    }
    if (m.before !== null) {
      g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(PAD - 8, Y); g.lineTo(PAD, Y); g.stroke();
      g.setLineDash([]);
    }
    // Idle cut out of history: a gap in the rail, so the jump in time is visible.
    let x0 = xo;
    for (const c of m.cuts) {
      const xc = this.x(c.m);
      if (xc <= x0 + 3 || xc >= xl) continue;
      g.beginPath(); g.moveTo(x0, Y); g.lineTo(xc - 2, Y); g.stroke();
      x0 = xc + 2;
    }
    g.beginPath(); g.moveTo(x0, Y); g.lineTo(xl, Y); g.stroke();
    g.font = '600 10.5px "CaskaydiaCove Nerd Font Mono",ui-monospace,monospace';
    g.textAlign = 'center';
    let lastLabel = -1e9, lastX = -1e9;
    for (let i = 1; i < n; i++) {
      const s = st[i];
      if (!(s.arr <= this.t1)) continue;
      const a = this.x(s.arr);
      if (s.kind === 'ask') {
        g.strokeStyle = P.muted;
        g.lineWidth = 1.4;
        g.beginPath(); g.arc(a, Y, 3.2, 0, 7); g.stroke();
        continue;
      }
      const end = Math.min(i + 1 < n ? st[i + 1].dep : Infinity, this.t1);
      const b = Math.max(a + 3, this.x(end) - 1.5);
      // A long history packs many stations into one pixel; draw each pixel once.
      if (b < lastX + 0.5) continue;
      lastX = b;
      const done = !Number.isNaN(s.done) && s.done <= this.t1;
      g.globalAlpha = s.past ? 0.45 : done ? 0.6 : 1;
      g.fillStyle = s.calls.some((c) => c.kind === 'fault') ? P.red : P.amber;
      g.beginPath(); g.roundRect(a, Y - 3, b - a, 6, 3); g.fill();
      g.globalAlpha = 1;
      if (s.kind === 'step' && a - lastLabel > 14) {
        g.fillStyle = i === at ? P.ink : P.faint;
        g.fillText(String(s.num + 1), a + 3, Y - 9);
        lastLabel = a;
      }
    }
    g.fillStyle = P.amber;
    g.beginPath(); g.arc(xl, Y, 3.6, 0, 7); g.fill();
    g.textAlign = 'left';
  }

  // Per frame: two transforms, written only when they change.
  place(T: number) {
    const xT = this.x(T), xl = this.x(this.t1);
    const hf = `translate3d(${xT.toFixed(1)}px,0,0)`;
    if (hf !== this.headTf) (this.head.style.transform = hf), (this.headTf = hf);
    // Dims what is ahead of the view, stopping short of the live dot so "now" stays lit.
    const af = `translate3d(${xT.toFixed(1)}px,0,0) scaleX(${(Math.max(0, xl - xT - 6) / this.w).toFixed(4)})`;
    if (af !== this.aheadTf) (this.ahead.style.transform = af), (this.aheadTf = af);
  }

  // The readout floats above the track, clear of the finger or cursor on it.
  show(t: number, text: string, line: boolean) {
    const x = this.x(t);
    if (text !== this.tipText) (this.tipText = text), (this.tip.textContent = text);
    this.tip.style.transform = `translate3d(${clamp(x, 120, this.w - 120).toFixed(0)}px,0,0)`;
    this.tip.classList.add('on');
    this.hov.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
    this.hov.classList.toggle('on', line);
  }

  hide() {
    this.tip.classList.remove('on');
    this.hov.classList.remove('on');
  }
}

// "−1:05" behind live; history from other days reads "−7d 16:01:18".
export function ago(s: number) {
  const n = Math.max(0, Math.round(s)), m = Math.floor(n / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const p = (v: number) => String(v).padStart(2, '0');
  return d ? `−${d}d ${p(h % 24)}:${p(m % 60)}:${p(n % 60)}` : h ? `−${h}:${p(m % 60)}:${p(n % 60)}` : `−${m}:${p(n % 60)}`;
}
