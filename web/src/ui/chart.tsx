import { useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { Card } from './card.tsx';
import { defineUi, text } from './define.ts';
import { loose } from './loose.ts';
import { draw, fade, grow, pop, type Stage } from './motion.ts';
import { clip, exact, inline, niceScale, plain, short, textWidth, withUnit } from './num.ts';
import { useWidth } from './size.ts';
import { Tip, type TipRow } from './tip.tsx';

const KIND: Record<string, string> = { horizontal: 'bar', vertical: 'column' };
const series = loose(z.object({ name: z.string().optional(), values: z.array(z.number()).min(1) }), { name: ['label'], values: ['data'] });
const schema = loose(
  z.object({
    title: z.string().optional(),
    // bar: horizontal rows; column: vertical bars along a category axis.
    kind: z.preprocess(
      (v) => (typeof v === 'string' && Object.hasOwn(KIND, v.toLowerCase()) ? KIND[v.toLowerCase()] : v),
      z.enum(['bar', 'column', 'line', 'area']),
    ),
    labels: z.array(text).min(1),
    series: z.array(series).min(1).max(4),
    unit: z.string().optional(),
    stacked: z.boolean().optional(),
  }),
  { series: ['data', 'datasets'], labels: ['categories', 'x'] },
);
type Data = z.output<typeof schema>;

// One series keeps the app's ink; several use a palette checked for colour-blind separation.
// CSS vars so marks, legend and tooltip swatches all follow the theme.
export const INK = 'var(--ink)';
const MUTED = 'var(--dot,#d9d4c7)';
export const ACCENT = 'var(--coral)';
// Slots 5-6 serve the donut only; the order keeps neighbours apart even when the ring wraps around.
export const PALETTE = ['var(--c1,#2f74c0)', 'var(--c2,#d4693f)', 'var(--c3,#b0469a)', 'var(--c4,#1f9a6c)', 'var(--c5,#c98a00)', 'var(--c6,#c94a4a)'];
const PAD = 16;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const colorOf = (b: Data, s: number) => (b.series.length === 1 ? INK : PALETTE[s]);
const nameOf = (b: Data, s: number) => b.series[s]?.name || (b.series.length === 1 ? '' : `Series ${s + 1}`);
const count = (b: Data) => Math.max(b.labels.length, ...b.series.map((s) => s.values.length));
const stackedOf = (b: Data) => !!b.stacked && b.series.length > 1 && (b.kind === 'bar' || b.kind === 'column');
const sumAt = (b: Data, i: number, sign: 1 | -1 | 0 = 0) =>
  b.series.reduce((a, s) => { const v = s.values[i] ?? 0; return a + (sign === 0 || Math.sign(v) === sign ? v : 0); }, 0);

function rowsAt(b: Data, i: number): TipRow[] {
  const rows = b.series.flatMap((s, j) => {
    const v = s.values[i];
    return v === undefined ? [] : [{ color: colorOf(b, j), name: nameOf(b, j), value: withUnit(exact(v), b.unit) }];
  });
  return stackedOf(b) ? [...rows, { color: 'transparent', name: 'Total', value: withUnit(exact(sumAt(b, i)), b.unit) }] : rows;
}

// Focusable plot: pointer or arrow keys pick a point, the tooltip reads it out.
function Plot({ b, active, setActive, at, children }: { b: Data; active: number | null; setActive: (i: number | null) => void; at: { x: number; y: number } | null; children: ReactNode }) {
  const n = count(b);
  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined && e.key !== 'Home' && e.key !== 'End' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return setActive(null);
    if (e.key === 'Home') return setActive(0);
    if (e.key === 'End') return setActive(n - 1);
    setActive(Math.min(n - 1, Math.max(0, (active ?? (step! > 0 ? -1 : n)) + step!)));
  };
  return (
    <div
      className="ub-plot" tabIndex={0} role="group"
      aria-label={`${b.title || 'Chart'}, ${stackedOf(b) ? 'stacked ' : ''}${b.kind} chart. Arrow keys read the values.`}
      onKeyDown={onKey}
      onFocus={(e) => e.currentTarget.matches(':focus-visible') && active === null && setActive(b.kind === 'bar' || b.kind === 'column' ? 0 : n - 1)}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
    >
      {children}
      <Tip at={at} title={active === null ? '' : String(b.labels[active] ?? '')} rows={active === null ? [] : rowsAt(b, active)} />
    </div>
  );
}

function barPath(a: number, e: number, y: number, h: number) {
  const len = Math.abs(e - a);
  if (len < 0.5) return '';
  const r = Math.min(4, h / 2, len);
  const d = e > a ? 1 : -1;
  const sw = d > 0 ? 1 : 0;
  const c = e - d * r;
  return `M${a} ${y}H${c}A${r} ${r} 0 0 ${sw} ${e} ${y + r}V${y + h - r}A${r} ${r} 0 0 ${sw} ${c} ${y + h}H${a}Z`;
}

function colPath(a: number, e: number, x: number, w: number) {
  const len = Math.abs(e - a);
  if (len < 0.5) return '';
  const r = Math.min(4, w / 2, len);
  const d = e < a ? 1 : -1;
  const sw = d > 0 ? 1 : 0;
  return `M${x} ${a}V${e + d * r}A${r} ${r} 0 0 ${sw} ${x + r} ${e}H${x + w - r}A${r} ${r} 0 0 ${sw} ${x + w} ${e + d * r}V${a}Z`;
}

// Stack pieces along one axis: [start, end] in value space, 2px gaps where pieces touch, a round end only on the outermost.
type Piece = { s: number; a: number; e: number; out: boolean };
function stackAt(b: Data, i: number): Piece[] {
  const out: Piece[] = [];
  let pos = 0;
  let neg = 0;
  b.series.forEach((x, s) => {
    const v = x.values[i];
    if (!v) return;
    if (v > 0) out.push({ s, a: pos, e: (pos += v), out: false });
    else out.push({ s, a: neg, e: (neg += v), out: false });
  });
  for (const sign of [1, -1]) {
    const last = out.findLast((p) => Math.sign(p.e - p.a) === sign);
    if (last) last.out = true;
  }
  return out;
}

function Bars({ b, w }: { b: Data; w: number }) {
  const [active, setActive] = useState<number | null>(null);
  const n = count(b);
  const stacked = stackedOf(b);
  const s = stacked ? 1 : b.series.length;
  const all = stacked ? range(n).flatMap((i) => [sumAt(b, i, 1), sumAt(b, i, -1)]) : b.series.flatMap((x) => x.values);
  const totals = stacked ? range(n).map((i) => sumAt(b, i)) : all;
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const top = Math.max(...(b.series[0]?.values ?? [0]));
  const val = (v: number) => (inline(b.unit) ? withUnit(plain(v), b.unit) : plain(v));
  const labW = Math.min(Math.max(...range(n).map((i) => textWidth(String(b.labels[i] ?? '')))), Math.max(60, w * 0.34), 220);
  const valW = Math.max(...totals.map((v) => textWidth(val(v)))) + 10;
  const L = PAD + labW + 12;
  const negRoom = lo < 0 ? valW : 0;
  const pw = Math.max(40, w - PAD - L - negRoom - (hi > 0 ? valW : 0));
  const xv = (v: number) => L + negRoom + ((v - lo) / (hi - lo || 1)) * pw;
  const x0 = xv(0);
  const bh = s > 1 ? 10 : 16;
  const rowH = s > 1 ? s * (bh + 2) - 2 + 14 : 30;
  const H = n * rowH + 4;
  // Tooltip sits past the row's furthest bar end and value label.
  const end = (v: number) => (v < 0 ? x0 : xv(v) + 6 + textWidth(val(v)));
  const at = active === null ? null : {
    x: stacked
      ? Math.max(x0, xv(sumAt(b, active, 1)) + 6 + textWidth(val(sumAt(b, active))))
      : Math.max(x0, ...b.series.map((x) => { const v = x.values[active]; return v === undefined ? x0 : end(v); })),
    y: active * rowH + rowH / 2,
  };
  return (
    <Plot b={b} active={active} setActive={setActive} at={at}>
      <svg className="ub-svg" width={w} height={H} data-n={n} aria-hidden="true">
        {active !== null && <rect className="ub-band" x="0" y={active * rowH} width={w} height={rowH} />}
        {range(n).map((i) => {
          const y0 = i * rowH + (rowH - (s * (bh + 2) - 2)) / 2;
          if (stacked) {
            const t = sumAt(b, i);
            const tx = t >= 0 || sumAt(b, i, 1) > 0 ? xv(sumAt(b, i, 1)) + 6 : xv(sumAt(b, i, -1)) - 6;
            return (
              <g key={i}>
                <text className="ub-lab" x={PAD} y={i * rowH + rowH / 2 + 4}>{clip(String(b.labels[i] ?? ''), labW)}</text>
                {/* Every piece scales from the shared baseline, so the stack grows as one bar. */}
                {stackAt(b, i).map((p) => {
                  const d = p.e > p.a ? 1 : -1;
                  const a = xv(p.a) + (p.a === 0 ? 0 : d);
                  const e = xv(p.e) - (p.out ? 0 : d);
                  return (
                    <path
                      key={p.s} className="ub-seg" data-i={i} data-ax="X" fill={PALETTE[p.s]}
                      d={p.out ? barPath(a, e, y0, bh) : Math.abs(e - a) < 0.5 ? '' : `M${a} ${y0}H${e}V${y0 + bh}H${a}Z`}
                      style={{ transformOrigin: `${x0}px 0` }}
                    />
                  );
                })}
                <text className="ub-val" data-i={i} x={tx} y={y0 + bh / 2 + 4} textAnchor={tx < x0 ? 'end' : 'start'}>{val(t)}</text>
              </g>
            );
          }
          return (
            <g key={i}>
              <text className="ub-lab" x={PAD} y={i * rowH + rowH / 2 + 4}>{clip(String(b.labels[i] ?? ''), labW)}</text>
              {b.series.map((x, j) => {
                const v = x.values[i];
                if (v === undefined) return null;
                const y = y0 + j * (bh + 2);
                const fill = s > 1 ? PALETTE[j] : v === top ? INK : MUTED;
                return (
                  <g key={j}>
                    <path className="ub-bar" data-i={i} data-s={j} d={barPath(x0, xv(v), y, bh)} fill={fill} style={{ transformOrigin: v < 0 ? 'right' : 'left' }} />
                    <text className="ub-val" data-i={i} data-s={j} x={v < 0 ? xv(v) - 6 : xv(v) + 6} y={y + bh / 2 + 4} textAnchor={v < 0 ? 'end' : 'start'}>{val(v)}</text>
                  </g>
                );
              })}
            </g>
          );
        })}
        {lo < 0 && <line className="ub-zero" x1={x0} x2={x0} y1="0" y2={H} />}
        {range(n).map((i) => <rect key={i} className="ub-hit" x="0" y={i * rowH} width={w} height={rowH} onPointerEnter={() => setActive(i)} />)}
      </svg>
    </Plot>
  );
}

// Thins category labels so none overlap; the last one is kept when it fits.
export function thin(n: number, slot: number, widest: number) {
  const every = Math.max(1, Math.ceil((widest + 14) / slot));
  const shown = range(n).filter((i) => i % every === 0);
  const tail = shown[shown.length - 1];
  if (n > 1 && tail !== n - 1) {
    if ((n - 1 - tail) * slot >= widest + 14) shown.push(n - 1);
    else if (shown.length > 1) shown[shown.length - 1] = n - 1;
  }
  return shown;
}

function Columns({ b, w }: { b: Data; w: number }) {
  const [active, setActive] = useState<number | null>(null);
  const n = count(b);
  const stacked = stackedOf(b);
  const s = stacked ? 1 : b.series.length;
  const all = stacked ? range(n).flatMap((i) => [sumAt(b, i, 1), sumAt(b, i, -1)]) : b.series.flatMap((x) => x.values);
  const caps = stacked ? range(n).map((i) => sumAt(b, i)) : s === 1 ? b.series[0].values : [];
  const top = Math.max(...(b.series[0]?.values ?? [0]));
  const val = (v: number) => (inline(b.unit) ? withUnit(plain(v), b.unit) : plain(v));
  const tick = (v: number) => (inline(b.unit) ? withUnit(short(v), b.unit) : short(v));
  const slot0 = (w - 2 * PAD) / n;
  // Values ride the caps when every one fits its slot; then the axis is redundant and drops out.
  const labelled = caps.length > 0 && Math.max(...caps.map((v) => textWidth(val(v)))) + 6 <= slot0;
  const sc = labelled ? { lo: Math.min(0, ...all), hi: Math.max(0, ...all), ticks: [] as number[] } : niceScale(Math.min(0, ...all), Math.max(0, ...all), 4);
  const gutter = labelled ? 0 : Math.ceil(Math.max(...sc.ticks.map((t) => textWidth(tick(t))))) + 10;
  const L = PAD + gutter;
  const pw = Math.max(40, w - PAD - L);
  const slot = pw / n;
  const T = labelled ? 20 : 12;
  const H = 168;
  const yv = (v: number) => T + ((sc.hi - v) / (sc.hi - sc.lo || 1)) * H;
  const y0 = yv(0);
  const bw = Math.max(2, Math.min(24, (slot * 0.72 - (s - 1) * 2) / s));
  const gw = s * bw + (s - 1) * 2;
  const cx = (i: number) => L + slot * i + slot / 2;
  const bx = (i: number, j: number) => cx(i) - gw / 2 + j * (bw + 2);
  const lab = (i: number) => clip(String(b.labels[i] ?? ''), Math.max(slot - 4, 140));
  const shown = thin(n, slot, Math.max(...range(n).map((i) => textWidth(lab(i)))));
  const bottom = T + H + (sc.lo < 0 && labelled ? 18 : 0);
  // Tooltip beside the group, level with its tallest mark.
  const at = active === null ? null : {
    x: cx(active) + gw / 2,
    y: Math.max(T, Math.min(y0, stacked ? yv(sumAt(b, active, 1)) : Math.min(...b.series.map((x) => yv(Math.max(0, x.values[active] ?? 0)))))) + 8,
  };
  return (
    <Plot b={b} active={active} setActive={setActive} at={at}>
      <svg className="ub-svg" width={w} height={bottom + 26} data-n={n} aria-hidden="true">
        {active !== null && <rect className="ub-band" x={L + slot * active} y={T - (labelled ? 18 : 0)} width={slot} height={bottom - T + (labelled ? 18 : 0)} rx="6" />}
        <g className="ub-axis">
          {sc.ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'ub-zero' : 'ub-grid'} x1={L} x2={w - PAD} y1={yv(t)} y2={yv(t)} />
              <text className="ub-tick" x={L - 8} y={yv(t) + 4} textAnchor="end">{tick(t)}</text>
            </g>
          ))}
          {labelled && <line className="ub-zero" x1={L} x2={w - PAD} y1={y0} y2={y0} />}
          {shown.map((i) => {
            const half = textWidth(lab(i)) / 2;
            return <text key={i} className="ub-tick" x={Math.min(Math.max(cx(i), PAD + half), w - PAD - half)} y={bottom + 18} textAnchor="middle">{lab(i)}</text>;
          })}
        </g>
        {range(n).map((i) => {
          if (stacked) {
            const t = sumAt(b, i);
            const up = t >= 0 || sumAt(b, i, 1) > 0;
            return (
              <g key={i}>
                {stackAt(b, i).map((p) => {
                  const d = p.e > p.a ? -1 : 1;
                  const a = yv(p.a) + (p.a === 0 ? 0 : d);
                  const e = yv(p.e) - (p.out ? 0 : d);
                  return (
                    <path
                      key={p.s} className="ub-seg" data-i={i} data-ax="Y" fill={PALETTE[p.s]}
                      d={p.out ? colPath(a, e, bx(i, 0), bw) : Math.abs(e - a) < 0.5 ? '' : `M${bx(i, 0)} ${a}V${e}H${bx(i, 0) + bw}V${a}Z`}
                      style={{ transformOrigin: `0 ${y0}px` }}
                    />
                  );
                })}
                {labelled && <text className="ub-val" data-i={i} x={cx(i)} y={up ? yv(sumAt(b, i, 1)) - 6 : yv(sumAt(b, i, -1)) + 15} textAnchor="middle">{val(t)}</text>}
              </g>
            );
          }
          return (
            <g key={i}>
              {b.series.map((x, j) => {
                const v = x.values[i];
                if (v === undefined) return null;
                const fill = s > 1 ? PALETTE[j] : v === top ? INK : MUTED;
                return (
                  <g key={j}>
                    <path className="ub-colb" data-i={i} data-s={j} d={colPath(y0, yv(v), bx(i, j), bw)} fill={fill} style={{ transformOrigin: v < 0 ? 'top' : 'bottom' }} />
                    {labelled && <text className="ub-val" data-i={i} data-s={j} x={cx(i)} y={v < 0 ? yv(v) + 15 : yv(v) - 6} textAnchor="middle">{val(v)}</text>}
                  </g>
                );
              })}
            </g>
          );
        })}
        {range(n).map((i) => <rect key={i} className="ub-hit" x={L + slot * i} y="0" width={slot} height={bottom} onPointerEnter={() => setActive(i)} />)}
      </svg>
    </Plot>
  );
}

// Inverse of the draw easing, so each point pops as the pen passes it.
const passAt = (f: number) => (f < 0.5 ? Math.cbrt(f / 4) : 1 - Math.cbrt(2 * (1 - f)) / 2);

function Lines({ b, w }: { b: Data; w: number }) {
  const [active, setActive] = useState<number | null>(null);
  const area = b.kind === 'area';
  const n = count(b);
  const single = b.series.length === 1;
  const all = b.series.flatMap((x) => x.values);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  // Areas encode size from zero; lines may zoom in unless the data already sits near zero.
  if (area || (lo >= 0 && lo <= hi * 0.35)) lo = Math.min(0, lo);
  if (area) hi = Math.max(0, hi);
  const sc = niceScale(lo, hi, 4);
  const tick = (v: number) => (inline(b.unit) ? withUnit(short(v), b.unit) : short(v));
  const gutter = Math.ceil(Math.max(...sc.ticks.map((t) => textWidth(tick(t))))) + 10;
  const last = single ? b.series[0].values.at(-1) : undefined;
  const endLabel = last === undefined ? '' : inline(b.unit) ? withUnit(plain(last), b.unit) : plain(last);
  const L = PAD + gutter;
  const R = w - PAD - (single ? Math.ceil(textWidth(endLabel)) + 12 : 6);
  const gid = `ubg${useId().replace(/[^\w-]/g, '')}`;
  const pw = Math.max(40, R - L);
  const T = 12;
  const H = 168;
  const x = (i: number) => (n === 1 ? L + pw / 2 : L + (i * pw) / (n - 1));
  const y = (v: number) => T + ((sc.hi - v) / (sc.hi - sc.lo || 1)) * H;
  const base = y(Math.min(Math.max(0, sc.lo), sc.hi));
  const slot = n > 1 ? pw / (n - 1) : pw;

  const lab = (i: number) => clip(String(b.labels[i] ?? ''), 140);
  const shown = thin(n, slot, Math.max(...range(n).map((i) => textWidth(lab(i)))));

  const dots = !area && n <= 24;
  const pick = (e: PointerEvent<SVGRectElement>) => {
    // The full-screen view scales the card, so map screen pixels back to SVG units.
    const r = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const px = (e.clientX - r.left) * (w / r.width) - L;
    setActive(n === 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(px / slot))));
  };
  const ys = active === null ? [] : b.series.flatMap((s) => (s.values[active] === undefined ? [] : [y(s.values[active])]));
  const at = active === null ? null : { x: x(active), y: ys.length ? ys.reduce((a, c) => a + c, 0) / ys.length : T + H / 2 };
  return (
    <Plot b={b} active={active} setActive={setActive} at={at}>
      <svg className="ub-svg" width={w} height={T + H + 30} data-n={n} aria-hidden="true">
        <g className="ub-axis">
          {sc.ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 && sc.lo < 0 ? 'ub-zero' : 'ub-grid'} x1={L} x2={w - PAD} y1={y(t)} y2={y(t)} />
              <text className="ub-tick" x={L - 8} y={y(t) + 4} textAnchor="end">{tick(t)}</text>
            </g>
          ))}
          {shown.map((i) => {
            const half = textWidth(lab(i)) / 2;
            return <text key={i} className="ub-tick" x={Math.min(Math.max(x(i), PAD + half), w - PAD - half)} y={T + H + 20} textAnchor="middle">{lab(i)}</text>;
          })}
        </g>
        {active !== null && <line className="ub-cross" x1={x(active)} x2={x(active)} y1={T} y2={T + H} />}
        {b.series.map((s, j) => {
          const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
          const k = s.values.length - 1;
          return (
            <g key={j}>
              {area && k > 0 && (
                <>
                  {/* Fading to the baseline keeps overlapping areas from muddying each other. */}
                  <linearGradient id={`${gid}-${j}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" style={{ stopColor: colorOf(b, j) }} stopOpacity={single ? 0.12 : 0.16} />
                    <stop offset="1" style={{ stopColor: colorOf(b, j) }} stopOpacity="0.02" />
                  </linearGradient>
                  <path className="ub-fill" data-s={j} d={`${d}L${x(k).toFixed(1)} ${base}L${x(0).toFixed(1)} ${base}Z`} fill={`url(#${gid}-${j})`} />
                </>
              )}
              {k > 0 && <path className="ub-line" data-s={j} d={d} pathLength={1} stroke={colorOf(b, j)} />}
              {dots && s.values.slice(0, -1).map((v, i) => (
                <circle key={i} className="ub-dot" data-s={j} data-f={i / Math.max(1, k)} cx={x(i)} cy={y(v)} r="3.5" fill={colorOf(b, j)} />
              ))}
              <circle className="ub-end" data-s={j} cx={x(k)} cy={y(s.values[k])} r="5" fill={single ? ACCENT : colorOf(b, j)} />
            </g>
          );
        })}
        {single && last !== undefined && (
          <text className="ub-endv" x={x(b.series[0].values.length - 1) + 10} y={y(last) + 4}>{endLabel}</text>
        )}
        {active !== null && b.series.map((s, j) => s.values[active] !== undefined && (
          <circle key={j} className="ub-on" cx={x(active)} cy={y(s.values[active])} r="4.5" fill={colorOf(b, j)} />
        ))}
        <rect className="ub-hit" x={PAD} y={T} width={w - 2 * PAD} height={H} onPointerMove={(e) => pick(e)} onPointerDown={(e) => pick(e)} />
      </svg>
    </Plot>
  );
}

function Legend({ b }: { b: Data }) {
  if (b.series.length < 2) return null;
  return (
    <span className="legend">
      {b.series.map((_, j) => <span key={j}><i className={b.kind === 'line' ? 'line' : 'box'} style={{ background: PALETTE[j] }}></i>{nameOf(b, j)}</span>)}
    </span>
  );
}

// Screen readers get the numbers as a table; the div clips it, since tables ignore a 1px size.
function DataTable({ b }: { b: Data }) {
  return (
    <div className="ub-sr"><table>
      <thead><tr><th>Label</th>{b.series.map((_, j) => <th key={j}>{nameOf(b, j) || 'Value'}</th>)}{stackedOf(b) && <th>Total</th>}</tr></thead>
      <tbody>
        {range(count(b)).map((i) => (
          <tr key={i}>
            <th>{String(b.labels[i] ?? '')}</th>
            {b.series.map((s, j) => <td key={j}>{s.values[i] === undefined ? '' : withUnit(exact(s.values[i]), b.unit)}</td>)}
            {stackedOf(b) && <td>{withUnit(exact(sumAt(b, i)), b.unit)}</td>}
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

const D0 = 60; // line draw start
const DS = 70; // stagger between series
const DD = 560; // line draw duration
const num = (el: Element, k: string) => Number((el as SVGElement).dataset[k] ?? 0);

const enter: Stage = (root) => {
  const q = (s: string) => root.querySelectorAll(s);
  const n = Math.max(1, num(root.querySelector('.ub-svg') ?? root, 'n'));
  // Bars: rows grow from the baseline top to bottom, values land as each bar settles.
  const row = Math.min(60, 320 / n);
  const barAt = (el: Element) => num(el, 'i') * row + num(el, 's') * 40;
  return [
    ...grow(q('.ub-bar'), 'X', { delay: barAt, duration: 520 }),
    // Columns rise left to right; stack pieces share one baseline origin and timing, so a stack grows as one bar.
    ...grow(q('.ub-colb'), 'Y', { delay: barAt, duration: 520 }),
    ...grow(q('.ub-seg[data-ax="X"]'), 'X', { delay: barAt, duration: 520 }),
    ...grow(q('.ub-seg[data-ax="Y"]'), 'Y', { delay: barAt, duration: 520 }),
    ...fade(q('.ub-val'), { delay: (el) => barAt(el) + 300, duration: 240 }),
    // Lines: axes settle, each series draws left to right, points pop as the pen passes, the fill follows.
    ...fade(q('.ub-axis'), { duration: 260 }),
    ...draw(q('.ub-line'), { delay: (el) => D0 + num(el, 's') * DS, duration: DD }),
    ...pop(q('.ub-dot'), { delay: (el) => D0 + num(el, 's') * DS + passAt(num(el, 'f')) * DD - 40, duration: 200 }),
    ...pop(q('.ub-end'), { delay: (el) => D0 + num(el, 's') * DS + DD - 60, duration: 260 }, 0.4),
    ...fade(q('.ub-fill'), { delay: (el) => D0 + num(el, 's') * DS + DD * 0.6, duration: 380 }),
    ...fade(q('.ub-endv'), { delay: D0 + DD + 40, duration: 240 }),
  ];
};

function Chart({ b }: { b: Data }) {
  const [ref, w] = useWidth();
  return (
    <Card
      title={b.title} label="Chart" stage={enter} className={`ub-chart ub-${b.kind}`}
      head={<>
        <Legend b={b} />
        {b.unit && !inline(b.unit) && <span className="ub-unit">{b.unit}</span>}
      </>}
    >
      <div ref={ref} className="ub-cw">
        {w > 0 && (b.kind === 'bar' ? <Bars b={b} w={w} /> : b.kind === 'column' ? <Columns b={b} w={w} /> : <Lines b={b} w={w} />)}
      </div>
      <DataTable b={b} />
    </Card>
  );
}

export const chart = defineUi({ schema, Component: Chart, label: 'Building chart…' });
