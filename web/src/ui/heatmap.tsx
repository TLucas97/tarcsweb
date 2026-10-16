import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { z } from 'zod';
import { Card } from './card.tsx';
import { thin } from './chart.tsx';
import { defineUi, text } from './define.ts';
import { fade, pop, type Stage } from './motion.ts';
import { clip, exact, inline, plain, short, textWidth, withUnit } from './num.ts';
import { useWidth } from './size.ts';
import { Tip } from './tip.tsx';

const schema = z.object({
  title: z.string().optional(),
  rows: z.array(text).min(1).max(24),
  cols: z.array(text).min(1).max(60),
  // values[row][col]; null or a missing cell means no data.
  values: z.array(z.array(z.number().nullable())).min(1),
  unit: z.string().optional(),
});
type Data = z.output<typeof schema>;

// One-hue sequential ramp, light to dark (blue 100-700): the darkest cell is the largest value.
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
// CSS vars per stop (dark theme runs the ramp dark to bright); color-mix does the same linear sRGB blend the JS did.
const STOPS = RAMP.map((h, i) => `var(--hm${i},${h})`);
function shade(t: number) {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const k = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - k;
  return `color-mix(in srgb, ${STOPS[k]}, ${STOPS[k + 1]} ${(f * 100).toFixed(2)}%)`;
}

const PAD = 16;
const GAP = 2;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function scale(b: Data) {
  const all = b.values.flat().filter((v): v is number => typeof v === 'number');
  let lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  // Counts read from zero unless the data sits far from it, as in the line chart.
  if (lo >= 0 && lo <= hi * 0.35) lo = 0;
  return { lo, hi, t: (v: number) => (hi === lo ? 0.6 : (v - lo) / (hi - lo)) };
}

const cellAt = (b: Data, r: number, c: number) => {
  const v = b.values[r]?.[c];
  return typeof v === 'number' ? v : null;
};

function Grid({ b, w }: { b: Data; w: number }) {
  const [active, setActive] = useState<[number, number] | null>(null);
  const nr = b.rows.length;
  const nc = b.cols.length;
  const sc = scale(b);
  const val = (v: number) => (inline(b.unit) ? withUnit(plain(v), b.unit) : plain(v));
  const labW = Math.min(Math.max(...b.rows.map((r) => textWidth(r))), Math.max(48, w * 0.28), 160);
  const L = PAD + labW + 10;
  const colLab = (c: number) => clip(b.cols[c], 120);
  const colW = Math.max(...range(nc).map((c) => textWidth(colLab(c))));
  // Few columns stay compact, but wide enough for every column label.
  const pitch = Math.max(6, Math.min(Math.max(56, colW + 16), (w - PAD - L) / nc));
  const rowH = Math.max(14, Math.min(30, pitch));
  const T = 22;
  const H = T + nr * rowH;
  const x = (c: number) => L + c * pitch;
  const y = (r: number) => T + r * rowH;
  const cw = pitch - GAP;
  const chh = rowH - GAP;
  const widest = Math.max(...b.values.flat().map((v) => (typeof v === 'number' ? textWidth(val(v), 11) : 0)));
  // Numbers ride inside the cells only when every one fits and the grid is small enough to read them all.
  const inCell = nr * nc <= 60 && chh >= 18 && widest + 8 <= cw;
  const shown = thin(nc, pitch, colW - 6);
  const gridR = x(nc) - GAP;

  // The full-screen view scales the card, so map screen pixels back to SVG units.
  const pick = (e: PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const px = (e.clientX - box.left) * (w / box.width);
    const py = (e.clientY - box.top) * ((H + 2) / box.height);
    const c = Math.floor((px - L) / pitch);
    const r = Math.floor((py - T) / rowH);
    setActive(c >= 0 && c < nc && r >= 0 && r < nr ? [r, c] : null);
  };
  const onKey = (e: KeyboardEvent) => {
    const mv: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    if (!(e.key in mv) && e.key !== 'Home' && e.key !== 'End' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return setActive(null);
    const [r, c] = active ?? [0, -1];
    if (e.key === 'Home') return setActive([Math.max(0, r), 0]);
    if (e.key === 'End') return setActive([Math.max(0, r), nc - 1]);
    const [dr, dc] = mv[e.key];
    setActive([Math.min(nr - 1, Math.max(0, r + dr)), Math.min(nc - 1, Math.max(0, c + dc))]);
  };
  const on = active && cellAt(b, active[0], active[1]);
  return (
    <div
      className="ub-plot" tabIndex={0} role="group"
      aria-label={`${b.title || 'Heatmap'}, heatmap of ${nr} rows by ${nc} columns. Arrow keys read the cells.`}
      onKeyDown={onKey}
      onFocus={(e) => e.currentTarget.matches(':focus-visible') && active === null && setActive([0, 0])}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
    >
      <svg className="ub-svg" width={w} height={H + 2} data-n={nr + nc} aria-hidden="true">
        <g className="ub-axis">
          {b.rows.map((r, i) => (
            <text key={i} className={`ub-lab${active?.[0] === i ? ' on' : ''}`} x={PAD} y={y(i) + chh / 2 + 4}>{clip(r, labW)}</text>
          ))}
          {shown.map((c) => {
            const half = textWidth(colLab(c)) / 2;
            return (
              <text key={c} className={`ub-tick${active?.[1] === c ? ' on' : ''}`} x={Math.min(Math.max(x(c) + cw / 2, L + half - 4), Math.max(gridR, w - PAD) - half)} y={T - 8} textAnchor="middle">{colLab(c)}</text>
            );
          })}
        </g>
        {range(nr).map((r) => range(nc).map((c) => {
          const v = cellAt(b, r, c);
          const t = v === null ? 0 : sc.t(v);
          return (
            <g key={`${r}-${c}`}>
              <rect className={`ub-cell${v === null ? ' none' : ''}`} data-r={r} data-c={c} x={x(c)} y={y(r)} width={cw} height={chh} rx="3" style={v === null ? undefined : { fill: shade(t) }} />
              {inCell && v !== null && (
                <text className={`ub-cv${t > 0.45 ? ' inv' : ''}`} data-r={r} data-c={c} x={x(c) + cw / 2} y={y(r) + chh / 2 + 4} textAnchor="middle">{val(v)}</text>
              )}
            </g>
          );
        }))}
        {active && <rect className="ub-hm-on" x={x(active[1]) - 1} y={y(active[0]) - 1} width={cw + 2} height={chh + 2} rx="4" />}
        <rect className="ub-hit" x={L} y={T} width={nc * pitch} height={nr * rowH} onPointerMove={pick} onPointerDown={pick} />
      </svg>
      <div className="ub-hm-key" style={{ marginLeft: L }} aria-hidden="true">
        <span>{inline(b.unit) ? withUnit(short(sc.lo), b.unit) : short(sc.lo)}</span>
        <i style={{ background: `linear-gradient(90deg,${STOPS.join(',')})` }}></i>
        <span>{inline(b.unit) ? withUnit(short(sc.hi), b.unit) : short(sc.hi)}</span>
        {b.values.flat().some((v) => typeof v !== 'number') || b.values.length < nr || b.values.some((r) => r.length < nc) ? <><i className="none"></i><span>No data</span></> : null}
      </div>
      <Tip
        at={active && { x: x(active[1]) + cw, y: y(active[0]) + chh / 2 }}
        title={active ? `${b.rows[active[0]]} · ${b.cols[active[1]]}` : ''}
        rows={active ? [{ color: on === null ? 'var(--soft)' : shade(sc.t(on)), value: on === null ? 'No data' : withUnit(exact(on), b.unit), name: '' }] : []}
      />
    </div>
  );
}

// Reading order as a diagonal wave from the top-left corner; labels settle first, the key last.
const enter: Stage = (root) => {
  const n = Number((root.querySelector('.ub-svg') as SVGElement | null)?.dataset.n ?? 2);
  const step = Math.min(30, 420 / Math.max(1, n - 1));
  const at = (el: Element) => 40 + (Number((el as SVGElement).dataset.r) + Number((el as SVGElement).dataset.c)) * step;
  return [
    ...fade(root.querySelectorAll('.ub-axis'), { duration: 220 }),
    ...pop(root.querySelectorAll('.ub-cell'), { delay: at, duration: 320 }, 0.6),
    ...fade(root.querySelectorAll('.ub-cv'), { delay: (el) => at(el) + 120, duration: 240 }),
    ...fade(root.querySelectorAll('.ub-hm-key'), { delay: 40 + n * step * 0.6, duration: 300 }),
  ];
};

function Heatmap({ b }: { b: Data }) {
  const [ref, w] = useWidth();
  return (
    <Card title={b.title} label="Heatmap" stage={enter} className="ub-chart ub-hm" head={b.unit && !inline(b.unit) ? <span className="ub-unit">{b.unit}</span> : undefined}>
      <div ref={ref} className="ub-cw">{w > 0 && <Grid b={b} w={w} />}</div>
      <div className="ub-sr"><table>
        <thead><tr><th></th>{b.cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {b.rows.map((r, i) => (
            <tr key={i}><th>{r}</th>{b.cols.map((_, j) => { const v = cellAt(b, i, j); return <td key={j}>{v === null ? 'No data' : withUnit(exact(v), b.unit)}</td>; })}</tr>
          ))}
        </tbody>
      </table></div>
    </Card>
  );
}

export const heatmap = defineUi({ schema, Component: Heatmap, label: 'Building heatmap…' });
