import type { ReactNode } from 'react';
import { Card } from './card.tsx';
import { defineUi } from './define.ts';
import { schema, type Data } from './matrix.schema.ts';
import { count, fade, grow, pop, rise, type Stage } from './motion.ts';

type Mark = 'good' | 'ok' | 'bad';
type Cell = { kind: 'num'; v: number; label: string } | { kind: 'mark'; m: Mark } | { kind: 'text'; t: string } | null;

const MARKS: Record<string, Mark> = {
  good: 'good', yes: 'good', y: 'good', true: 'good', pass: 'good', '✓': 'good', '✔': 'good', '✅': 'good', '+': 'good',
  ok: 'ok', okay: 'ok', partial: 'ok', some: 'ok', mixed: 'ok', fair: 'ok', '~': 'ok', '±': 'ok',
  bad: 'bad', no: 'bad', n: 'bad', false: 'bad', fail: 'bad', poor: 'bad', '✗': 'bad', '✕': 'bad', '❌': 'bad', '-': 'bad',
};
const MARK_TEXT: Record<Mark, string> = { good: 'Good', ok: 'Partial', bad: 'Poor' };
const MARK_VALUE: Record<Mark, number> = { good: 1, ok: 0.5, bad: 0 };
const NUM = /^\s*(-?\d+(?:\.\d+)?)\s*(?:\/\s*\d+(?:\.\d+)?)?\s*$/;

function cellOf(raw: unknown): Cell {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'boolean') return { kind: 'mark', m: raw ? 'good' : 'bad' };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { kind: 'num', v: raw, label: String(raw) } : null;
  const s = String(raw);
  const n = NUM.exec(s);
  if (n) return { kind: 'num', v: Number(n[1]), label: n[1] };
  const m = MARKS[s.trim().toLowerCase()];
  return m ? { kind: 'mark', m } : { kind: 'text', t: s };
}

// Scale top: given, else the smallest common one that holds every score.
const scaleOf = (b: Data, cells: Cell[][]) => {
  if (b.max) return b.max;
  const hi = Math.max(0, ...cells.flat().map((c) => (c?.kind === 'num' ? c.v : 0)));
  return [1, 3, 5, 10, 100].find((s) => hi <= s) ?? hi;
};

const fmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: v % 1 ? 1 : 0 });

const CHECK = <path d="M2.5 6.2 5 8.5l4.5-5" />;
const TILDE = <path d="M2.5 6.5c1.2-1.6 2.3-1.6 3.5 0s2.3 1.6 3.5 0" />;
const CROSS = <path d="M3 3l6 6M9 3 3 9" />;
const GLYPH: Record<Mark, ReactNode> = { good: CHECK, ok: TILDE, bad: CROSS };

function MarkCell({ m }: { m: Mark }) {
  return (
    <span className={`ub-mx-mk ${m}`} title={MARK_TEXT[m]}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[m]}</svg>
      <span className="ub-sr">{MARK_TEXT[m]}</span>
    </span>
  );
}

function Meter({ v, max, top, label, total }: { v: number; max: number; top: boolean; label: string; total?: boolean }) {
  const pct = Math.max(0, Math.min(1, v / max)) * 100;
  return (
    <span className="ub-mx-sc">
      <span className="ub-mx-tk" aria-hidden="true"><i className={`ub-mx-f${top ? ' top' : ''}`} style={{ width: `${pct}%` }} /></span>
      {total ? (
        <b className="ub-mx-n ub-mx-tot">
          <span className="ub-ghost" aria-hidden="true">{label}</span>
          <span className="ub-mx-cnt" aria-hidden="true">{label}</span>
          <span className="ub-sr">{label.endsWith('%') ? label : `${label} of ${max}`}</span>
        </b>
      ) : (
        <span className="ub-mx-n">{label}<span className="ub-sr"> of {max}</span></span>
      )}
    </span>
  );
}

const num = (el: Element, k: string) => Number((el as HTMLElement).dataset[k] ?? 0);

// Option names land left to right, then each criterion fills across its row, top to bottom; the totals count up last.
const enter: Stage = (root) => {
  const q = (s: string) => root.querySelectorAll(s);
  const rows = Math.max(1, q('tbody tr').length);
  const step = Math.min(60, 360 / rows);
  const at = (el: Element) => 100 + num(el.closest('tr')!, 'r') * step + num(el.closest('td') ?? el, 'c') * 30;
  return [
    ...rise(q('thead th'), { stagger: 50, duration: 300 }, 4),
    ...fade(q('tbody th'), { delay: (el) => at(el) - 30, duration: 260 }),
    ...grow(q('.ub-mx-f'), 'X', { delay: at, duration: 440 }),
    ...fade(q('.ub-mx-n:not(.ub-mx-tot), .ub-mx-tx'), { delay: (el) => at(el) + 140, duration: 220 }),
    ...pop(q('.ub-mx-mk'), { delay: at, duration: 260 }, 0.7),
    // Totals stay hidden until they start counting, so no row of zeros waits below.
    ...fade(q('.ub-mx-tot'), { delay: at, duration: 120 }),
    ...count(q('.ub-mx-cnt'), { delay: at, duration: 420 }),
    ...fade(q('.ub-mx-best'), { delay: 100 + (rows - 1) * step + 340, duration: 220 }),
  ];
};

function Matrix({ b }: { b: Data }) {
  const crits = b.criteria.map((c, i) => ({ ...c, weight: c.weight ?? b.weights?.[i] }));
  const cells = b.options.map((o) => crits.map((c, i) => cellOf(Array.isArray(o.scores) ? o.scores[i] : o.scores[c.name])));
  // With marks only, the total reads as a share of the best possible.
  const marksOnly = !cells.flat().some((c) => c?.kind === 'num');
  const max = marksOnly ? 100 : scaleOf(b, cells);
  const totalLabel = (t: number) => (marksOnly ? `${Math.round(t)}%` : t.toFixed(1));
  const weighted = crits.some((c) => c.weight !== undefined && c.weight !== 1);
  const w = (i: number) => crits[i].weight ?? 1;
  // Weighted mean on the same scale; marks count as full, half or nothing.
  const totals = cells.map((row) => {
    let sum = 0;
    let ws = 0;
    row.forEach((c, i) => {
      const v = c?.kind === 'num' ? c.v : c?.kind === 'mark' ? MARK_VALUE[c.m] * max : null;
      if (v === null) return;
      sum += v * w(i);
      ws += w(i);
    });
    return ws ? sum / ws : null;
  });
  const scored = totals.filter((t) => t !== null).length;
  const showTotal = scored > 0 && crits.length > 1;
  const hi = Math.max(...totals.map((t) => t ?? -Infinity));
  const lead = totals.filter((t) => t === hi).length === 1 ? totals.indexOf(hi) : -1;
  const best = b.pick !== undefined ? b.options.findIndex((o) => o.name === b.pick) : b.options.length > 1 && showTotal ? lead : -1;
  const rowTop = crits.map((_, i) => Math.max(...cells.map((r) => (r[i]?.kind === 'num' ? r[i].v : -Infinity))));
  const pk = (j: number) => (j === best ? 'ub-pk' : undefined);
  return (
    <Card title={b.title} label="Scores" stage={enter} className="ub-mx" head={weighted ? <span className="ub-unit">weighted</span> : undefined}>
      <div className="ub-scroll">
        <table>
          <thead>
            <tr>
              <td className="ub-k"></td>
              {b.options.map((o, j) => (
                <th key={j} scope="col" className={pk(j)}>
                  <span className="ub-nm">{o.name}</span>
                  {(o.tag || j === best) && (
                    <span className="ub-chips">
                      {j === best && <span className="ub-rec ub-mx-best">{b.pick !== undefined ? 'Recommended' : 'Top score'}</span>}
                      {o.tag && <span className="ub-tag">{o.tag}</span>}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {crits.map((c, i) => (
              <tr key={i} data-r={i}>
                <th scope="row" className="ub-k">
                  {c.name}
                  {weighted && <span className="ub-mx-w" title="Weight"><span className="ub-sr">, weight </span>×{fmt(w(i))}</span>}
                </th>
                {cells.map((row, j) => {
                  const x = row[i];
                  return (
                    <td key={j} data-c={j} className={pk(j)}>
                      {x === null ? <span className="ub-none">—</span>
                        : x.kind === 'num' ? <Meter v={x.v} max={max} top={x.v === rowTop[i] && b.options.length > 1} label={x.label} />
                        : x.kind === 'mark' ? <MarkCell m={x.m} />
                        : <span className="ub-mx-tx">{x.t}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            {showTotal && (
              <tr className="ub-mx-total" data-r={crits.length}>
                <th scope="row" className="ub-k">{weighted ? 'Weighted score' : marksOnly ? 'Overall' : 'Average'}</th>
                {totals.map((t, j) => (
                  <td key={j} data-c={j} className={pk(j)}>
                    {t === null ? <span className="ub-none">—</span> : <Meter v={t} max={max} top={j === lead} label={totalLabel(t)} total />}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export const matrix = defineUi({ schema, Component: Matrix, label: 'Scoring options…' });
