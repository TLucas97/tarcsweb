import { z } from 'zod';
import { fact, loose } from './loose.ts';

const item = loose(
  z.object({ name: z.string(), tag: z.string().optional(), facts: z.record(z.string(), fact), note: z.string().optional() }),
  { facts: ['specs', 'attributes', 'values'] },
);
export const schema = z.object({
  title: z.string().optional(),
  items: z.array(item).min(2).max(4),
  pick: z.string().optional(),
});
export type Data = z.output<typeof schema>;
