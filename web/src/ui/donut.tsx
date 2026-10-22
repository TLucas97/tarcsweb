import { useState, type KeyboardEvent } from 'react';
import { Card } from './card.tsx';
import { PALETTE } from './chart.tsx';
import { defineUi } from './define.ts';
import { schema, type Data } from './donut.schema.ts';
import { count, draw, EASE_DRAW, fade, rise, type Stage } from './motion.ts';
import { exact, inline, plain, withUnit } from './num.ts';

const S = 148; // ring box
const SW = 22; // ring thickness
const RAD = (S - SW) / 2;
const C = S / 2;

const pct = (v: number, t: number) => {
  const p = (v / t) * 100;
  return `${p === 0 || p >= 10 ? Math.round(p) : Number(p.toFixed(1))}%`;
};

function arc(a: number, b: number) {
  const pt = (f: number) => {
    const t = f * 2 * Math.PI - Math.PI / 2;
    return `${(C + RAD * Math.cos(t)).toFixed(2)} ${(C + RAD * Math.sin(t)).toFixed(2)}`;
  };
  // A full ring is two half arcs; one arc command cannot close on itself.
  if (b - a >= 0.9999) return `M${pt(0)}A${RAD} ${RAD} 0 1 1 ${pt(0.5)}A${RAD} ${RAD} 0 1 1 ${pt(0.99999)}`;
  return `M${pt(a)}A${RAD} ${RAD} 0 ${b - a > 0.5 ? 1 : 0} 1 ${pt(b)}`;
}

// Slices as [start, end] fractions of the ring, clockwise from 12 o'clock, with a 2px surface gap between neighbours.
function slices(b: Data) {
  const total = b.items.reduce((a, it) => a + it.value, 0);
  const live = b.items.filter((it) => it.value > 0).length;
  const gap = live > 1 ? 2 / (2 * Math.PI * RAD) : 0;
  let acc = 0;
  return b.items.map((it, i) => {
    const a = acc / total;
    acc += it.value;
    const e = acc / total;
    return { i, a, e, s: it.value > 0 ? Math.min(a + gap / 2, (a + e) / 2) : a, f: it.value > 0 ? Math.max(e - gap / 2, (a + e) / 2) : a };
  });
}

// Cubic bezier sampled once: progress at time x, and the time at which progress reaches y.
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const c = (p1: number, p2: number, u: number) => 3 * p1 * u * (1 - u) ** 2 + 3 * p2 * u * u * (1 - u) + u ** 3;
  const pts = Array.from({ length: 201 }, (_, k) => [c(x1, x2, k / 200), c(y1, y2, k / 200)]);
  const look = (from: 0 | 1, v: number) => {
    const k = pts.findIndex((p) => p[from] >= v);
    if (k <= 0) return pts[Math.max(0, k)][1 - from];
    const [p, q] = [pts[k - 1], pts[k]];
    return p[1 - from] + ((v - p[from]) / (q[from] - p[from] || 1)) * (q[1 - from] - p[1 - from]);
  };
  return { at: (x: number) => look(0, x), when: (y: number) => look(1, y) };
}
const SWEEP_E = bezier(0.65, 0, 0.35, 1); // EASE_DRAW
const SWEEP = 720;
const LINEAR_OK = typeof CSS !== 'undefined' && CSS.supports('animation-timing-function', 'linear(0, 1)');

// Each slice draws over its share of one eased sweep, so the ring reads as a single stroke going round.
function sweep(el: SVGPathElement) {
  const a = Number(el.dataset.a);
  const b = Number(el.dataset.b);
  const ta = SWEEP_E.when(a) * SWEEP;
  const tb = SWEEP_E.when(b) * SWEEP;
  const span = b - a || 1;
  const steps = Array.from({ length: 11 }, (_, k) => Math.min(1, Math.max(0, (SWEEP_E.at((ta + ((tb - ta) * k) / 10) / SWEEP) - a) / span)).toFixed(3));
  return draw([el], { duration: Math.max(1, tb - ta), delay: D0 + ta, easing: LINEAR_OK ? `linear(${steps.join(',')})` : 'linear' }, ARC);
}
const ARC: Keyframe[] = [{ strokeDasharray: '1 2', strokeDashoffset: 1 }, { strokeDasharray: '1 2', strokeDashoffset: 0 }];
const D0 = 60;
const startOf = (el: Element) => D0 + SWEEP_E.when(Number((el as HTMLElement).dataset.a ?? 0)) * SWEEP;

// The ring sweeps clockwise as the total counts up; each legend row lands as its slice starts.
const enter: Stage = (root) => [
  ...Array.from(root.querySelectorAll<SVGPathElement>('.ub-dn-arc')).flatMap(sweep),
  ...count(root.querySelectorAll('.ub-dn-cnt'), { delay: D0, duration: SWEEP, easing: EASE_DRAW }),
  ...fade(root.querySelectorAll('.ub-dn-cap'), { delay: D0 + 120, duration: 300 }),
  ...rise(root.querySelectorAll('.ub-dn-row'), { delay: (el) => startOf(el), duration: 300 }, 4),
];

function Donut({ b }: { b: Data }) {
  const [active, setActive] = useState<number | null>(null);
  const total = b.items.reduce((a, it) => a + it.value, 0);
  const val = (v: number) => (inline(b.unit) ? withUnit(plain(v), b.unit) : plain(v));
  const parts = slices(b);
  const n = b.items.length;
  const on = active === null ? null : b.items[active];
  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined && e.key !== 'Home' && e.key !== 'End' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return setActive(null);
    if (e.key === 'Home') return setActive(0);
    if (e.key === 'End') return setActive(n - 1);
    setActive(((active ?? (step! > 0 ? -1 : n)) + step! + n) % n);
  };
  return (
    <Card title={b.title} label="Share" stage={enter} className="ub-dnf" head={b.unit && !inline(b.unit) ? <span className="ub-unit">{b.unit}</span> : undefined}>
      <div
        className="ub-dn ub-plot" tabIndex={0} role="group" data-on={active === null ? undefined : ''}
        aria-label={`${b.title || 'Share'}, donut chart. Arrow keys read the slices.`}
        onKeyDown={onKey}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && active === null && setActive(0)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <div className="ub-dn-ring">
          <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true">
            {parts.map((p) => p.f - p.s > 0.0005 && (
              <path
                key={p.i} className={`ub-dn-arc${active === p.i ? ' on' : ''}`} d={arc(p.s, p.f)} pathLength={1}
                data-a={p.s} data-b={p.f} stroke={PALETTE[p.i]} strokeWidth={SW}
                onPointerEnter={() => setActive(p.i)}
              />
            ))}
          </svg>
          {/* Both readouts share one cell, so swapping them on hover never moves anything. */}
          <div className="ub-dn-mid" aria-hidden="true">
            <div className="ub-dn-fig" hidden={on !== null}>
              <b className="ub-num"><span className="ub-ghost">{b.total ?? val(total)}</span><span className="ub-dn-cnt ub-cnt">{b.total ?? val(total)}</span></b>
              <small className="ub-dn-cap">{b.center ?? 'Total'}</small>
            </div>
            {on && (
              <div className="ub-dn-fig">
                <b className="ub-num">{withUnit(exact(on.value), inline(b.unit) ? b.unit : '')}</b>
                <small>{pct(on.value, total)} · {on.label}</small>
              </div>
            )}
          </div>
        </div>
        <ul className="ub-dn-leg">
          {b.items.map((it, i) => (
            <li key={i} className={`ub-dn-row${active === i ? ' on' : ''}`} data-a={parts[i].s} onPointerEnter={() => setActive(i)}>
              <i style={{ background: PALETTE[i] }}></i>
              <span className="ub-dn-l" title={it.label}>{it.label}</span>
              <span className="ub-dn-v">{val(it.value)}</span>
              <span className="ub-dn-p">{pct(it.value, total)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="ub-sr"><table>
        <thead><tr><th>Label</th><th>Value</th><th>Share</th></tr></thead>
        <tbody>
          {b.items.map((it, i) => <tr key={i}><th>{it.label}</th><td>{withUnit(exact(it.value), b.unit)}</td><td>{pct(it.value, total)}</td></tr>)}
          <tr><th>{b.center ?? 'Total'}</th><td>{b.total ?? withUnit(exact(total), b.unit)}</td><td>100%</td></tr>
        </tbody>
      </table></div>
    </Card>
  );
}

export const donut = defineUi({ schema, Component: Donut, label: 'Building donut…' });
