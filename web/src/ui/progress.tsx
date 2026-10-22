import { useRef, useState, type KeyboardEvent } from 'react';
import { Card } from './card.tsx';
import { INK } from './chart.tsx';
import { defineUi } from './define.ts';
import { count, draw, EASE_OUT, fade, rise, type Stage } from './motion.ts';
import { exact, inline, plain, withUnit } from './num.ts';
import { schema, type Data } from './progress.schema.ts';
import { Tip, type TipRow } from './tip.tsx';
type Item = Data['items'][number];

const FILL = { good: 'var(--green)', bad: 'var(--red)', neutral: INK };
const maxOf = (b: Data, it: Item) => it.max ?? b.max ?? 100;
const unitOf = (b: Data, it: Item) => it.unit ?? b.unit;
const frac = (v: number, m: number) => Math.min(1, Math.max(0, v / m));
const pct = (v: number, m: number) => `${Number(((v / m) * 100).toFixed(v / m < 0.1 ? 1 : 0))}%`;
// "62%" when the scale is a plain percentage, otherwise "62" over "/ 100 GB".
function parts(b: Data, it: Item) {
  const m = maxOf(b, it);
  const u = unitOf(b, it);
  if (u === '%' && m === 100) return { v: `${plain(it.value)}%`, of: '' };
  return { v: inline(u) ? withUnit(plain(it.value), u) : plain(it.value), of: `/ ${withUnit(plain(m), u)}` };
}

function tipRows(b: Data, it: Item): TipRow[] {
  const m = maxOf(b, it);
  const u = unitOf(b, it);
  const rows: TipRow[] = [{ color: FILL[it.tone ?? 'neutral'], value: withUnit(exact(it.value), u), name: `${pct(it.value, m)} of ${withUnit(plain(m), u)}` }];
  if (it.target !== undefined) {
    const gap = it.target - it.value;
    rows.push({ color: 'transparent', value: withUnit(exact(it.target), u), name: gap > 0 ? `target, ${withUnit(plain(gap), u)} to go` : 'target, reached' });
  }
  return rows;
}

const n = (el: Element, k: string) => Number((el as HTMLElement).dataset[k] ?? 0);
const DUR = 620;

// Bars: rows land top to bottom, each fill slides in from its start as the number counts, then the target tick lands.
// Gauges: each arc sweeps to its value as the number counts.
const enter: Stage = (root) => {
  const rows = root.querySelectorAll('.ub-pg-row');
  const step = Math.min(60, 360 / Math.max(1, rows.length));
  const at = (el: Element) => 60 + n(el, 'i') * step;
  return [
    ...rise(rows, { stagger: step, duration: 300 }, 4),
    ...Array.from(root.querySelectorAll<HTMLElement>('.ub-pg-fill'), (el) =>
      el.animate([{ transform: 'translateX(-100%)' }, { transform: el.style.transform }], { duration: DUR, delay: at(el), easing: EASE_OUT, fill: 'backwards' })),
    ...Array.from(root.querySelectorAll<SVGPathElement>('.ub-gg-fill')).flatMap((el) =>
      draw([el], { duration: DUR + 80, delay: at(el), easing: EASE_OUT }, [{ strokeDashoffset: el.dataset.f }, { strokeDashoffset: 0 }])),
    ...count(root.querySelectorAll('.ub-pg-cnt'), { delay: at, duration: DUR }),
    ...fade(root.querySelectorAll('.ub-pg-tg, .ub-gg-tg'),{ delay: (el) => at(el) + DUR - 160, duration: 240 }),
  ];
};

// The hidden copy reserves the final width, so counting never moves the layout.
function Num({ s, i }: { s: string; i: number }) {
  return (
    <b className="ub-pg-n">
      <span className="ub-ghost" aria-hidden="true">{s}</span>
      <span className="ub-pg-cnt" data-i={i}>{s}</span>
    </b>
  );
}

function Bars({ b }: { b: Data }) {
  const [active, setActive] = useState<{ i: number; x: number; y: number } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  // Layout offsets (relative to the .ub-plot box) ignore the full-screen view's scale; the tip hangs just under the bar it reads.
  const pick = (i: number) => {
    const track = list.current?.children[i]?.querySelector<HTMLElement>('.ub-pg-bar');
    if (!track) return;
    const it = b.items[i];
    setActive({ i, x: track.offsetLeft + track.offsetWidth * frac(Math.max(it.value, it.target ?? 0), maxOf(b, it)), y: track.offsetTop + 34 });
  };
  const onKey = (e: KeyboardEvent) => {
    const k = b.items.length;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined && e.key !== 'Home' && e.key !== 'End' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return setActive(null);
    pick(e.key === 'Home' ? 0 : e.key === 'End' ? k - 1 : Math.min(k - 1, Math.max(0, (active?.i ?? (step! > 0 ? -1 : k)) + step!)));
  };
  const on = active === null ? null : b.items[active.i];
  return (
    <div
      className="ub-plot ub-pg" tabIndex={0} role="group"
      aria-label={`${b.title || 'Progress'}. Arrow keys read the values.`}
      onKeyDown={onKey}
      onFocus={(e) => e.currentTarget.matches(':focus-visible') && active === null && pick(0)}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
    >
      <ul ref={list}>
        {b.items.map((it, i) => {
          const m = maxOf(b, it);
          const p = parts(b, it);
          const tone = it.tone ?? 'neutral';
          return (
            <li key={i} className={`ub-pg-row ${tone}${active?.i === i ? ' on' : ''}`} data-i={i} onPointerEnter={() => pick(i)}>
              <div className="ub-pg-top">
                <span className="ub-pg-l" title={it.label}>{it.label}</span>
                <span className="ub-pg-v"><Num s={p.v} i={i} />{p.of && <span className="ub-pg-of" data-i={i}>{p.of}</span>}</span>
              </div>
              <div className="ub-pg-bar">
                <div className="ub-pg-track">
                  <div className="ub-pg-fill" data-i={i} style={{ transform: `translateX(${((frac(it.value, m) - 1) * 100).toFixed(2)}%)`, background: FILL[tone] }}></div>
                </div>
                {it.target !== undefined && <i className="ub-pg-tg" data-i={i} style={{ left: `${(frac(it.target, m) * 100).toFixed(2)}%` }}></i>}
              </div>
              {it.hint && <small className="ub-pg-h">{it.hint}</small>}
            </li>
          );
        })}
      </ul>
      <Tip at={active && { x: active.x, y: active.y }} title={on ? String(on.label) : ''} rows={on ? tipRows(b, on) : []} />
    </div>
  );
}

const GW = 132; // gauge width
const GS = 12; // arc thickness
const GR = (GW - GS) / 2;
const GH = GR + GS / 2 + 2;

function Gauges({ b }: { b: Data }) {
  const half = `M${GS / 2} ${GR + GS / 2}A${GR} ${GR} 0 0 1 ${GW - GS / 2} ${GR + GS / 2}`;
  return (
    // The table below carries the numbers for screen readers.
    <ul className="ub-gg" aria-hidden="true">
      {b.items.map((it, i) => {
        const m = maxOf(b, it);
        const f = frac(it.value, m);
        const p = parts(b, it);
        const tone = it.tone ?? 'neutral';
        const t = it.target === undefined ? null : Math.PI * (1 - frac(it.target, m));
        const cy = GR + GS / 2;
        return (
          <li key={i} className={`ub-pg-row ub-gg-t ${tone}`} data-i={i}>
            <div className="ub-gg-dial">
              <svg width={GW} height={GH} aria-hidden="true">
                <path className="ub-gg-track" d={half} pathLength={1} strokeWidth={GS} />
                {f > 0 && <path className="ub-gg-fill" data-i={i} data-f={f} d={half} pathLength={1} strokeWidth={GS} stroke={FILL[tone]} strokeDasharray={`${f} 2`} />}
                {t !== null && (
                  <line
                    className="ub-gg-tg" data-i={i}
                    x1={GW / 2 + (GR - GS / 2 - 3) * Math.cos(t)} y1={cy - (GR - GS / 2 - 3) * Math.sin(t)}
                    x2={GW / 2 + (GR + GS / 2 + 3) * Math.cos(t)} y2={cy - (GR + GS / 2 + 3) * Math.sin(t)}
                  />
                )}
              </svg>
              <div className="ub-gg-mid"><Num s={p.v} i={i} /></div>
            </div>
            <span className="ub-pg-l" title={it.label}>{it.label}</span>
            {(p.of || it.target !== undefined) && (
              <small className="ub-pg-of" data-i={i}>
                {[p.of.replace(/^\/ /, 'of '), it.target !== undefined && `target ${withUnit(plain(it.target), unitOf(b, it))}`].filter(Boolean).join(' · ')}
              </small>
            )}
            {it.hint && <small className="ub-pg-h">{it.hint}</small>}
          </li>
        );
      })}
    </ul>
  );
}

function Progress({ b }: { b: Data }) {
  const gauge = b.kind === 'gauge';
  return (
    <Card
      title={b.title} label="Progress" stage={enter}
      className={`ub-pgf${gauge ? ` ub-ggf ub-n${Math.min(b.items.length, 4)}` : ''}`}
    >
      {gauge ? <Gauges b={b} /> : <Bars b={b} />}
      <div className="ub-sr"><table>
        <thead><tr><th>Label</th><th>Value</th><th>Max</th><th>Target</th></tr></thead>
        <tbody>
          {b.items.map((it, i) => (
            <tr key={i}>
              <th>{it.label}</th>
              <td>{withUnit(exact(it.value), unitOf(b, it))} ({pct(it.value, maxOf(b, it))})</td>
              <td>{withUnit(exact(maxOf(b, it)), unitOf(b, it))}</td>
              <td>{it.target === undefined ? '' : withUnit(exact(it.target), unitOf(b, it))}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Card>
  );
}

export const progress = defineUi({ schema, Component: Progress, label: 'Building progress…' });
