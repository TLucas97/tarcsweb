import { Card } from './card.tsx';
import { defineUi } from './define.ts';
import { SAY, type Status } from './loose.ts';
import { draw, grow, pop, rise, type Stage } from './motion.ts';
import { useWidth } from './size.ts';
import { schema, type Data } from './steps.schema.ts';

const MIN_COL = 140; // narrowest column a horizontal step gets before the list turns vertical
const MAX_ROW = 5;

// Per-item states win; otherwise `current` (1-based, or a step title) marks earlier steps done and later ones next.
function states(b: Data): Status[] {
  if (b.items.some((s) => s.state)) return b.items.map((s) => s.state);
  const c = b.current;
  if (c === undefined) return b.items.map(() => undefined);
  const n = typeof c === 'number' || /^\d+$/.test(c.trim()) ? Number(c) - 1 : b.items.findIndex((s) => s.title === c);
  if (n < 0 || n >= b.items.length) return b.items.map(() => undefined);
  return b.items.map((_, i) => (i < n ? 'done' : i === n ? 'now' : 'next'));
}

const CHECK = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path className="ub-ck" pathLength="1" d="M2.5 6.2 5 8.6 9.6 3.6" />
  </svg>
);

// Each marker lands, then its connector runs on to the next one; text follows its marker.
const enter: Stage = (root) => {
  const items = [...root.querySelectorAll('.ub-sp-i')];
  const gap = items.length > 1 ? Math.min(150, 520 / (items.length - 1)) : 0;
  const axis = root.querySelector('.ub-sp-l.h') ? 'X' : 'Y';
  return items.flatMap((li, i) => [
    ...pop(li.querySelectorAll('.ub-sp-n'), { delay: i * gap, duration: 260 }, 0.6),
    ...draw(li.querySelectorAll('.ub-ck'), { delay: i * gap + 110, duration: 240 }),
    ...grow(li.querySelectorAll('.ub-sp-s'), axis, { delay: i * gap + 40, duration: Math.max(120, gap - 20) }),
    ...rise(li.querySelectorAll('.ub-sp-c'), { delay: i * gap + 40, duration: 300 }, 4),
  ]);
};

function Steps({ b }: { b: Data }) {
  const [ref, w] = useWidth<HTMLOListElement>();
  const n = b.items.length;
  const st = states(b);
  const horiz = n <= MAX_ROW && n > 1 && w >= n * MIN_COL;
  return (
    <Card title={b.title} label="Steps" stage={enter} className={`ub-sp ub-sn${Math.min(n, MAX_ROW + 1)}`}>
      <ol ref={ref} className={`ub-sp-l ${horiz ? 'h' : 'v'}`}>
        {b.items.map((it, i) => {
          const s = st[i];
          const nx = st[i + 1];
          return (
            <li key={i} className={`ub-sp-i ${s ?? 'plain'}`} aria-current={s === 'now' ? 'step' : undefined}>
              <span className="ub-sp-m" aria-hidden="true">
                <b className="ub-sp-n">{s === 'done' ? CHECK : i + 1}</b>
                {i < n - 1 && <i className={`ub-sp-s${nx === 'done' || nx === 'now' ? ' on' : ''}`}></i>}
              </span>
              <div className="ub-sp-c">
                <span className="ub-sp-t">
                  <span className="ub-sr">Step {i + 1}: </span>
                  {it.title}
                  {s && <span className="ub-sr">, {SAY[s]}</span>}
                </span>
                {it.detail && <span className="ub-sp-x">{it.detail}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export const steps = defineUi({ schema, Component: Steps, label: 'Building steps…' });
