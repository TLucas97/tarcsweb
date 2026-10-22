import { z } from 'zod';
import { text } from './loose.ts';

export const schema = z.object({
  title: z.string().optional(),
  kind: z.enum(['bar', 'gauge']).optional(),
  unit: z.string().optional(),
  max: z.number().positive().optional(),
  items: z.array(z.object({
    label: text,
    value: z.number(),
    max: z.number().positive().optional(),
    target: z.number().optional(),
    unit: z.string().optional(),
    tone: z.enum(['good', 'bad', 'neutral']).optional(),
    hint: z.string().optional(),
  })).min(1).max(8),
});
export type Data = z.output<typeof schema>;
