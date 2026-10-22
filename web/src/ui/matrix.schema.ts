import { z } from 'zod';
import { text } from './loose.ts';

const crit = z.union([
  text.transform((name) => ({ name, weight: undefined as number | undefined })),
  z.object({ name: text, weight: z.coerce.number().nonnegative().optional() }),
]);
const cell = z.union([z.number(), z.string(), z.boolean(), z.null()]).optional();
const option = z.object({
  name: text,
  scores: z.union([z.array(cell), z.record(z.string(), cell)]),
  tag: text.optional(),
});

export const schema = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    return { ...o, options: o.options ?? o.items ?? o.rows, criteria: o.criteria ?? o.columns };
  },
  z.object({
    title: z.string().optional(),
    criteria: z.array(crit).min(1).max(12),
    options: z.array(option).min(1).max(6),
    weights: z.array(z.coerce.number().nonnegative()).optional(),
    max: z.coerce.number().positive().optional(),
    pick: text.optional(),
  }),
);
export type Data = z.output<typeof schema>;
