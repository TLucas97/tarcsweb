import { Card } from './card.tsx';
import { defineUi } from './define.ts';
import { SAY, timeAt } from './loose.ts';
import { pop, rise, type Stage } from './motion.ts';
import { schema, type Data } from './timeline.schema.ts';

const DRAW = [0.65, 0, 0.35, 1] as const; // EASE_DRAW
const center = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

// The rail draws down in one stroke; each event lands as the stroke reaches its dot.
const enter: Stage = (root) => {
  const items = [...root.querySelectorAll('.ub-tl-i')];
  const ys = items.map((li) => center(li.querySelector('.ub-tl-dot')!));
  const span = ys.at(-1)! - ys[0];
  const total = Math.min(520, 130 * (items.length - 1));
  const at = ys.map((y) => (span > 0 ? Math.round(total * timeAt((y - ys[0]) / span, DRAW)) : 0));
  return items.flatMap((li, i) => {
    const seg = li.querySelector('.ub-tl-s');
    return [
      ...pop([li.querySelector('.ub-tl-dot')!], { delay: at[i], duration: 260 }, 0.4),
      ...rise(li.querySelectorAll('.ub-tl-d,.ub-tl-c'), { delay: at[i] + 40, duration: 300 }, 4),
      // Linear per segment: joined end to end they trace the one eased stroke.
      ...(seg ? [seg.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], { delay: at[i], duration: Math.max(1, at[i + 1] - at[i]), easing: 'linear', fill: 'backwards' })] : []),
    ];
  });
};

function Timeline({ b }: { b: Data }) {
  const dated = b.items.some((it) => it.date);
  return (
    <Card title={b.title} label="Timeline" stage={enter} className={`ub-tl${dated ? '' : ' ub-nod'}`}>
      <ol className="ub-tl-l">
        {b.items.map((it, i) => {
          const nx = b.items[i + 1]?.state;
          return (
            <li key={i} className={`ub-tl-i ${it.state ?? 'plain'}`} aria-current={it.state === 'now' ? 'step' : undefined}>
              {dated && <span className="ub-tl-d">{it.date}</span>}
              <span className="ub-tl-r" aria-hidden="true">
                {i < b.items.length - 1 && <i className={`ub-tl-s${nx === 'done' || nx === 'now' ? ' on' : ''}`}></i>}
                <b className="ub-tl-dot"></b>
              </span>
              <div className="ub-tl-c">
                <span className="ub-tl-t">
                  {it.title}
                  {it.state === 'now' && <span className="ub-tl-now" aria-hidden="true">Now</span>}
                  {it.state && <span className="ub-sr">, {SAY[it.state]}</span>}
                </span>
                {it.detail && <span className="ub-tl-x">{it.detail}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export const timeline = defineUi({ schema, Component: Timeline, label: 'Building timeline…' });
