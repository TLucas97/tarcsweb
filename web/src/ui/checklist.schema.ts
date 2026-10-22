import { z } from 'zod';
import { loose, status, text } from './loose.ts';

const entry = loose(
  z.object({ text, done: z.union([z.boolean(), z.string(), z.number()]).optional(), state: status, note: text.optional() }),
  { text: ['title', 'label', 'name', 'item', 'task'], note: ['detail', 'description', 'reason', 'why'], state: ['status'] },
  'text',
);
export const schema = loose(z.object({ title: z.string().optional(), items: z.array(entry).min(1).max(30) }), { items: ['checks', 'tasks'] });
export type Data = z.output<typeof schema>;
