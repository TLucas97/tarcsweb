import { useId } from 'react';
import { z } from 'zod';
import { Card } from './card.tsx';
import { defineUi, fact, text } from './define.ts';
import { loose } from './loose.ts';
import { fade, rise, type Stage } from './motion.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const row = loose(
  z.object({ key: text, value: z.preprocess((v) => v ?? '—', fact), hint: text.optional() }),
  { key: ['k', 'label', 'name', 'term'], value: ['v', 'val', 'definition'], hint: ['note', 'detail'] },
);
// Rows come as [{key, value}], [[key, value]] or a plain {key: value} object.
const rows = z.preprocess(
  (v) => (Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? { key: x[0], value: x[1] } : x)) : isRecord(v) ? Object.entries(v).map(([key, value]) => ({ key, value })) : v),
  z.array(row),
);
const group = loose(z.object({ title: text.optional(), items: rows }), { title: ['name', 'label'], items: ['rows', 'facts', 'entries'] });
const schema = loose(
  z
    .object({
      title: z.string().optional(),
      items: rows.optional(),
      groups: z.preprocess((v) => (isRecord(v) ? Object.entries(v).map(([title, items]) => ({ title, items })) : v), z.array(group)).optional(),
    })
    .refine((b) => b.items?.length || b.groups?.some((g) => g.items.length), { message: 'needs items or groups' }),
  { items: ['rows', 'facts', 'entries', 'data'] },
);
type Data = z.output<typeof schema>;

// A value written as `code` keeps a code look (paths, ids, versions).
const val = (s: string) => (/^`[^`]+`$/.test(s) ? <code>{s.slice(1, -1)}</code> : s);

// Top to bottom; within a row the key leads and its value follows a beat later.
const enter: Stage = (root) => {
  const marks = [...root.querySelectorAll('.ub-kv-gt,.ub-kv-r')];
  const gap = Math.min(40, 420 / Math.max(1, marks.length));
  return marks.flatMap((el, i) =>
    el.classList.contains('ub-kv-gt')
      ? fade([el], { delay: i * gap, duration: 260 })
      : [...rise([el], { delay: i * gap, duration: 300 }, 4), ...fade(el.querySelectorAll('dd'), { delay: i * gap + 60, duration: 260 })],
  );
};

function Kv({ b }: { b: Data }) {
  const id = useId();
  const groups = [...(b.items?.length ? [{ title: undefined, items: b.items }] : []), ...(b.groups ?? []).filter((g) => g.items.length)];
  return (
    <Card title={b.title} label="Facts" stage={enter} className="ub-kv">
      <div className="ub-kv-w">
        {groups.map((g, gi) => (
          <div key={gi} className="ub-kv-g" role={g.title ? 'group' : undefined} aria-labelledby={g.title ? `${id}-${gi}` : undefined}>
            {g.title && <div className="ub-kv-gt" id={`${id}-${gi}`}>{g.title}</div>}
            <dl className="ub-kv-l">
              {g.items.map((r, i) => (
                <div key={i} className="ub-kv-r">
                  <dt>{r.key}</dt>
                  <dd>
                    {val(r.value)}
                    {r.hint && <small>{r.hint}</small>}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Card>
  );
}

export const kv = defineUi({ schema, Component: Kv, label: 'Building facts…' });
