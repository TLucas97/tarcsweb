import { z } from 'zod';
import { text } from './loose.ts';

// A point may come as plain text or as an object with the text under a common key.
const point = z.union([text, z.object({ text: text.optional(), label: text.optional(), title: text.optional() })]).transform((p) => (typeof p === 'string' ? p : p.text ?? p.label ?? p.title ?? ''));
const points = z.array(point).default([]).transform((a) => a.filter(Boolean));
const option = z.object({ name: text.optional(), pros: points, cons: points, verdict: text.optional() });

// One option may be written flat, without `items`.
export const schema = z.preprocess(
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
export type Data = z.output<typeof schema>;
