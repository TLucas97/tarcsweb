import { z } from 'zod';
import { loose, text } from './loose.ts';

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
export const schema = loose(z.object({ title: z.string().optional(), items: z.array(item).min(1).max(6) }), { items: ['metrics'] });
export type Data = z.output<typeof schema>;
