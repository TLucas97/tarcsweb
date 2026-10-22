import { Card } from './card.tsx';
import { schema, type Data } from './compare.schema.ts';
import { defineUi } from './define.ts';
import { rise, type Stage } from './motion.ts';

// Reading order: option names left to right, then each fact row top to bottom.
const enter: Stage = (root) => {
  const rows = [...root.querySelectorAll('tbody tr')];
  const step = Math.min(45, 360 / Math.max(1, rows.length));
  return [
    ...rise(root.querySelectorAll('thead th'), { stagger: 60, duration: 320 }, 4),
    ...rows.flatMap((tr, r) => rise(tr.children, { delay: 120 + r * step, stagger: 18, duration: 320 }, 4)),
  ];
};

function Compare({ b }: { b: Data }) {
  const keys = [...new Set(b.items.flatMap((it) => Object.keys(it.facts)))];
  const notes = b.items.some((it) => it.note);
  const pk = (name: string) => (b.pick !== undefined && name === b.pick ? 'ub-pk' : undefined);
  return (
    <Card title={b.title} label="Comparison" stage={enter} className="ub-cmp">
      <div className="ub-scroll">
        <table>
          <thead>
            <tr>
              <td className="ub-k"></td>
              {b.items.map((it, i) => (
                <th key={i} scope="col" className={pk(it.name)}>
                  <span className="ub-nm">{it.name}</span>
                  {(it.tag || pk(it.name)) && (
                    <span className="ub-chips">
                      {pk(it.name) && <span className="ub-rec">Recommended</span>}
                      {it.tag && <span className="ub-tag">{it.tag}</span>}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k}>
                <th scope="row" className="ub-k">{k}</th>
                {b.items.map((it, i) => {
                  const v = Object.hasOwn(it.facts, k) ? it.facts[k] : undefined;
                  return <td key={i} className={pk(it.name)}>{v ?? <span className="ub-none">—</span>}</td>;
                })}
              </tr>
            ))}
            {notes && (
              <tr className="ub-notes">
                <td className="ub-k"></td>
                {b.items.map((it, i) => <td key={i} className={pk(it.name)}>{it.note}</td>)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export const compare = defineUi({ schema, Component: Compare, label: 'Building comparison…' });
