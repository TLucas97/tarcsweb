import { z } from 'zod';
import { Card } from './card.tsx';
import { ACCENT } from './chart.tsx';
import { defineUi, text } from './define.ts';
import { loose } from './loose.ts';
import { count, draw, pop, rise, type Stage } from './motion.ts';
import { exact } from './num.ts';
import { useWidth } from './size.ts';

const item = loose(
  z.object({
    label: z.string(),
    value: text,
    delta: text.optional(),
    tone: z.enum(['good', 'bad', 'neutral']).optional(),
    hint: z.string().optional(),
    trend: z.array(z.number()).min(2).max(60).optional(),
  }),
  { label: ['name', 'title'] },
);
const schema = loose(z.object({ title: z.string().optional(), items: z.array(item).min(1).max(6) }), { items: ['metrics'] });
type Data = z.output<typeof schema>;

const TILE = 60; // stagger between tiles
const idx = (el: Element) => Number((el as HTMLElement).dataset.i ?? 0);

// Tiles rise in reading order, each number counts up, the delta lands once its number settles.
// A trend line draws while its number counts, and its latest point lands last.
const enter: Stage = (root) => [
  ...rise(root.querySelectorAll('.ub-st'), { stagger: TILE, duration: 340 }),
  ...count(root.querySelectorAll('.ub-cnt'), { delay: (el) => idx(el) * TILE, duration: 720 }),
  ...rise(root.querySelectorAll('.ub-d'), { delay: (el) => idx(el) * TILE + 460, duration: 260 }, 4),
  ...draw(root.querySelectorAll('.ub-spl'), { delay: (el) => idx(el) * TILE + 80, duration: 520 }),
  ...pop(root.querySelectorAll('.ub-spe'), { delay: (el) => idx(el) * TILE + 560, duration: 220 }, 0.4),
];

const SH = 28; // sparkline height
const R = 5; // room for the end dot and its ring

function Spark({ v, i }: { v: number[]; i: number }) {
  const [ref, w] = useWidth();
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const x = (k: number) => 1 + (k * (w - 1 - R)) / (v.length - 1);
  const y = (n: number) => (hi === lo ? SH / 2 : R + ((hi - n) / (hi - lo)) * (SH - 2 * R));
  const d = v.map((n, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)} ${y(n).toFixed(1)}`).join('');
  const last = v[v.length - 1];
  return (
    <div ref={ref} className="ub-spk" role="img" aria-label={`Trend over ${v.length} points: from ${exact(v[0])} to ${exact(last)}, low ${exact(lo)}, high ${exact(hi)}`}>
      {w > 0 && (
        <svg width={w} height={SH} aria-hidden="true">
          <path className="ub-spl" data-i={i} d={d} pathLength={1} />
          <circle className="ub-spe" data-i={i} cx={x(v.length - 1)} cy={y(last)} r="3" fill={ACCENT} />
        </svg>
      )}
    </div>
  );
}

function Stats({ b }: { b: Data }) {
  return (
    <Card title={b.title} label="Numbers" head={false} stage={enter} className={`ub-statf ub-n${b.items.length}`}>
      <div className="ub-stats">
        {b.items.map((it, i) => (
          <div key={i} className="ub-st">
            <div className="ub-v">
              {/* The hidden copy reserves the final width, so counting never moves the layout. */}
              <b className="ub-num">
                <span className="ub-sr">{it.value}</span>
                <span className="ub-ghost" aria-hidden="true">{it.value}</span>
                <span className="ub-cnt" data-i={i} aria-hidden="true">{it.value}</span>
              </b>
              {it.delta && <span className={`ub-d ${it.tone ?? 'neutral'}`} data-i={i}>{it.delta}</span>}
            </div>
            <small className="ub-l">{it.label}</small>
            {it.hint && <small className="ub-h">{it.hint}</small>}
            {it.trend && <Spark v={it.trend} i={i} />}
          </div>
        ))}
      </div>
    </Card>
  );
}

export const stats = defineUi({ schema, Component: Stats, label: 'Building stats…' });
