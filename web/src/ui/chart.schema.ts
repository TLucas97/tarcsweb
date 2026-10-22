import { z } from 'zod';
import { loose, text } from './loose.ts';

const KIND: Record<string, string> = { horizontal: 'bar', vertical: 'column' };
const series = loose(z.object({ name: z.string().optional(), values: z.array(z.number()).min(1) }), { name: ['label'], values: ['data'] });
export const schema = loose(
  z.object({
    title: z.string().optional(),
    // bar: horizontal rows; column: vertical bars along a category axis.
    kind: z.preprocess(
      (v) => (typeof v === 'string' && Object.hasOwn(KIND, v.toLowerCase()) ? KIND[v.toLowerCase()] : v),
      z.enum(['bar', 'column', 'line', 'area']),
    ),
    labels: z.array(text).min(1),
    series: z.array(series).min(1).max(4),
    unit: z.string().optional(),
    stacked: z.boolean().optional(),
  }),
  { series: ['data', 'datasets'], labels: ['categories', 'x'] },
);
export type Data = z.output<typeof schema>;
