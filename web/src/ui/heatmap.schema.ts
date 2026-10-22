import { z } from 'zod';
import { text } from './loose.ts';

export const schema = z.object({
  title: z.string().optional(),
  rows: z.array(text).min(1).max(24),
  cols: z.array(text).min(1).max(60),
  // values[row][col]; null or a missing cell means no data.
  values: z.array(z.array(z.number().nullable())).min(1),
  unit: z.string().optional(),
});
export type Data = z.output<typeof schema>;
