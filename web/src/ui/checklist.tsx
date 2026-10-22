import type { ReactNode } from 'react';
import { Card } from './card.tsx';
import { schema, type Data } from './checklist.schema.ts';
import { defineUi } from './define.ts';
import { count, draw, fade, grow, pop, rise, type Stage } from './motion.ts';
type Mark = 'done' | 'todo' | 'blocked';

function markOf(it: Data['items'][number]): Mark {
  if (it.state === 'blocked') return 'blocked';
  if (it.state === 'done') return 'done';
  const d = it.done;
  return d === true || d === 1 || (typeof d === 'string' && /^(true|yes|done|x|1)$/i.test(d.trim())) ? 'done' : 'todo';
}

const SAY: Record<Mark, string> = { done: 'Done: ', todo: 'Not done: ', blocked: 'Blocked: ' };
const ICON: Record<Mark, ReactNode> = {
  done: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path className="ub-ck" pathLength="1" d="M2.5 6.2 5 8.6 9.6 3.6" />
    </svg>
  ),
  blocked: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path className="ub-ck" pathLength="1" d="M3.2 6h5.6" />
    </svg>
  ),
  todo: null,
};

// Rows rise in order and each finished one ticks; the tally counts along and the bar fills over the same span.
const enter: Stage = (root) => {
  const rows = [...root.querySelectorAll('.ub-cl-i')];
  const gap = Math.min(55, 420 / Math.max(1, rows.length));
  const span = Math.max(360, (rows.length - 1) * gap + 260);
  return [
    ...fade(root.querySelectorAll('.ub-cl-p'), { duration: 240 }),
    ...grow(root.querySelectorAll('.ub-cl-f'), 'X', { delay: 80, duration: span }),
    ...count(root.querySelectorAll('.ub-cl-cnt'), { delay: 80, duration: span }),
    ...rows.flatMap((li, i) => [
      ...rise([li], { delay: 60 + i * gap, duration: 300 }, 4),
      ...pop(li.querySelectorAll('.ub-cl-b:is(.done,.blocked)'), { delay: 120 + i * gap, duration: 220 }, 0.7),
      ...draw(li.querySelectorAll('.ub-ck'), { delay: 190 + i * gap, duration: 220 }),
    ]),
  ];
};

function Checklist({ b }: { b: Data }) {
  const marks = b.items.map(markOf);
  const done = marks.filter((m) => m === 'done').length;
  const blocked = marks.filter((m) => m === 'blocked').length;
  const n = b.items.length;
  return (
    <Card title={b.title} label="Checklist" stage={enter} className="ub-cl">
      <div className="ub-cl-p">
        <span className="ub-cl-tally">
          {/* The hidden copy reserves the final width, so counting never moves the line. */}
          <b className="ub-cl-num">
            <span className="ub-sr">{done}</span>
            <span className="ub-ghost" aria-hidden="true">{done}</span>
            <span className="ub-cl-cnt" aria-hidden="true">{done}</span>
          </b>{' '}
          of {n} done
          {blocked > 0 && <span className="ub-cl-bk"> · {blocked} blocked</span>}
        </span>
        <span className="ub-cl-bar" aria-hidden="true">
          <i className="ub-cl-f" style={{ width: `${(done / n) * 100}%` }}></i>
        </span>
      </div>
      <ul className="ub-cl-l">
        {b.items.map((it, i) => {
          const m = marks[i];
          return (
            <li key={i} className={`ub-cl-i ${m}`}>
              <span className={`ub-cl-b ${m}`} aria-hidden="true">{ICON[m]}</span>
              <div className="ub-cl-c">
                <span className="ub-cl-t"><span className="ub-sr">{SAY[m]}</span>{it.text}</span>
                {it.note && <span className="ub-cl-n">{it.note}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export const checklist = defineUi({ schema, Component: Checklist, label: 'Building checklist…' });
