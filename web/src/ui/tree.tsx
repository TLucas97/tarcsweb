import { useState } from 'react';
import { FileIcon } from '../FileTree.tsx';
import { Card } from './card.tsx';
import { defineUi } from './define.ts';
import { EASE_OUT, rise, type Stage } from './motion.ts';
import { StatusMark } from './files.tsx';
import { schema, type Data, type T } from './tree.schema.ts';

// File trees get icons; any other hierarchy gets plain chevrons and dots.
const filey = (list: T[]): boolean => list.some((n) => /\.\w{1,8}$/.test(n.name) || (n.dir && !n.kids.length) || filey(n.kids));

const CHEV = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" /></svg>
);

// Branches unfold top-down: rows drop in, in reading order, while each guide line grows down its branch.
const enter: Stage = (root) => {
  const rows = [...root.querySelectorAll('.ub-tr-row')];
  const step = Math.min(32, 560 / Math.max(1, rows.length));
  const at = new Map(rows.map((r, i) => [r, i * step]));
  return [
    ...rise(rows, { delay: (el) => at.get(el) ?? 0, duration: 280 }, -5),
    ...Array.from(root.querySelectorAll('.ub-tr-g'), (g) => {
      const inner = g.parentElement!.querySelectorAll('.ub-tr-row');
      const first = at.get(inner[0]) ?? 0;
      return g.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], {
        delay: first, duration: Math.min(620, inner.length * step + 180), easing: EASE_OUT, fill: 'backwards',
      });
    }),
  ];
};

function Level({ list, icons, closed, fresh, flip }: { list: T[]; icons: boolean; closed: Set<string>; fresh: Set<string>; flip: (id: string) => void }) {
  return (
    <ul>
      {list.map((n) => {
        const parent = n.kids.length > 0;
        const open = parent && !closed.has(n.id);
        const inner = (
          <>
            {icons ? <FileIcon name={n.name} dir={n.dir} open={open} /> : !parent && <span className="ub-tr-dot" aria-hidden="true" />}
            <span className="ub-tr-nm">{n.name}</span>
            {n.note && <span className="ub-tr-note">{n.note}</span>}
            {n.st && <StatusMark s={n.st} />}
          </>
        );
        return (
          <li key={n.id}>
            {parent ? (
              <button type="button" className={`ub-tr-row${n.hl ? ' ub-tr-hl' : ''}`} aria-expanded={open} onClick={() => flip(n.id)}>
                <span className="ub-tr-chev">{CHEV}</span>
                {inner}
              </button>
            ) : (
              <div className={`ub-tr-row${n.hl ? ' ub-tr-hl' : ''}`}>
                <span className="ub-tr-chev" />
                {inner}
              </div>
            )}
            {open && (
              <div className={fresh.has(n.id) ? 'ub-tr-kids new' : 'ub-tr-kids'}>
                <i className="ub-tr-g" aria-hidden="true" />
                <Level list={n.kids} icons={icons} closed={closed} fresh={fresh} flip={flip} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Tree({ b }: { b: Data }) {
  const [closed, setClosed] = useState(() => {
    const s = new Set<string>();
    const walk = (list: T[]) => list.forEach((n) => (n.open === false && n.kids.length && s.add(n.id), walk(n.kids)));
    walk(b.nodes);
    return s;
  });
  // Branches the user opened fade in; the entrance owns everything rendered on mount.
  const [fresh, setFresh] = useState(() => new Set<string>());
  const flip = (id: string) => {
    const opening = closed.has(id);
    setClosed((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    if (opening) setFresh((s) => new Set(s).add(id));
  };
  return (
    <Card title={b.title} label="Tree" stage={enter} className="ub-tr">
      <div className="ub-tr-wrap">
        <Level list={b.nodes} icons={filey(b.nodes)} closed={closed} fresh={fresh} flip={flip} />
      </div>
    </Card>
  );
}

export const tree = defineUi({ schema, Component: Tree, label: 'Building tree…' });
