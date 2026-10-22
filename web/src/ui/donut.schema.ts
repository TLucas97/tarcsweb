import { z } from 'zod';
import { text } from './loose.ts';

export const schema = z.object({
  title: z.string().optional(),
  items: z.array(z.object({ label: text, value: z.number().nonnegative() })).min(1).max(6),
  unit: z.string().optional(),
  // Center text: the total by default, or a caller's own figure and caption.
  total: text.optional(),
  center: z.string().optional(),
}).refine((b) => b.items.some((it) => it.value > 0), { message: 'needs at least one value above 0', path: ['items'] });
export type Data = z.output<typeof schema>;
