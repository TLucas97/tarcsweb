import { z } from 'zod';
import { Card } from './card.tsx';
import { defineUi, text } from './define.ts';
import { rise, type Stage } from './motion.ts';

// A point may come as plain text or as an object with the text under a common key.
const point = z.union([text, z.object({ text: text.optional(), label: text.optional(), title: text.optional() })]).transform((p) => (typeof p === 'string' ? p : p.text ?? p.label ?? p.title ?? ''));
const points = z.array(point).default([]).transform((a) => a.filter(Boolean));
const option = z.object({ name: text.optional(), pros: points, cons: points, verdict: text.optional() });

// One option may be written flat, without `items`.
const schema = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    if (o.items === undefined && Array.isArray(o.options)) return { ...o, items: o.options };
    if (o.items === undefined && (o.pros || o.cons)) return { ...o, items: [{ name: o.name, pros: o.pros, cons: o.cons }] };
    return v;
  },
  z.object({
    title: z.string().optional(),
    items: z.array(option).min(1).max(4),
    verdict: text.optional(),
    pick: text.optional(),
  }),
);
type Data = z.output<typeof schema>;

const PLUS = <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
const MINUS = <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;

// Reading order: each option's name, its pros, then its cons, then the verdict.
const enter: Stage = (root) => {
  const seq = [...root.querySelectorAll('.ub-pc-s')];
  const step = Math.min(48, Math.max(18, 560 / Math.max(1, seq.length)));
  return rise(seq, { stagger: step, duration: 320 }, 5);
};

function Points({ kind, list, label }: { kind: 'pro' | 'con'; list: string[]; label: string }) {
  return (
    <div className={`ub-pc-col ${kind}`}>
      <div className="ub-pc-h ub-pc-s">{label}</div>
      {list.length ? (
        <ul aria-label={label}>
          {list.map((p, i) => (
            <li key={i} className="ub-pc-s">
              <span className="ub-pc-m">{kind === 'pro' ? PLUS : MINUS}</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ub-pc-none ub-pc-s">None</p>
      )}
    </div>
  );
}

function ProsCons({ b }: { b: Data }) {
  const many = b.items.length > 1;
  return (
    <Card title={b.title} label={many ? 'Pros and cons' : b.items[0].name || 'Pros and cons'} stage={enter} className="ub-pc">
      {b.items.map((it, i) => {
        const picked = b.pick !== undefined && it.name === b.pick;
        return (
          <section key={i} className={`ub-pc-opt${picked ? ' ub-pk' : ''}`} aria-label={it.name || undefined}>
            {it.name && (many || b.title) && (
              <div className="ub-pc-name ub-pc-s">
                <span className="ub-nm">{it.name}</span>
                {picked && <span className="ub-rec">Recommended</span>}
              </div>
            )}
            <div className="ub-pc-cols">
              <Points kind="pro" list={it.pros} label="Pros" />
              <Points kind="con" list={it.cons} label="Cons" />
            </div>
            {it.verdict && <p className="ub-pc-v ub-pc-s">{it.verdict}</p>}
          </section>
        );
      })}
      {b.verdict && (
        <p className="ub-pc-final ub-pc-s"><b>Verdict</b>{b.verdict}</p>
      )}
    </Card>
  );
}

export const proscons = defineUi({ schema, Component: ProsCons, label: 'Weighing pros and cons…' });
