import { z } from 'zod';
import { loose, status, text } from './loose.ts';

const step = loose(
  z.object({ title: text, detail: text.optional(), state: status }),
  { title: ['label', 'name', 'text', 'step'], detail: ['description', 'desc', 'details', 'body', 'note'], state: ['status'] },
  'title',
);
export const schema = loose(
  z.object({ title: z.string().optional(), items: z.array(step).min(1).max(12), current: z.union([z.number(), z.string()]).optional() }),
  { items: ['steps'], current: ['active', 'now'] },
);
export type Data = z.output<typeof schema>;
