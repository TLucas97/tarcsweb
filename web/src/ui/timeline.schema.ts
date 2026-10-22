import { z } from 'zod';
import { loose, status, text } from './loose.ts';

const item = loose(
  z.object({ date: text.optional(), title: text, detail: text.optional(), state: status }),
  { title: ['event', 'label', 'name', 'text'], detail: ['description', 'desc', 'details', 'body', 'note'], date: ['when', 'time', 'at'], state: ['status'] },
  'title',
);
export const schema = loose(z.object({ title: z.string().optional(), items: z.array(item).min(1).max(24) }), { items: ['events'] });
export type Data = z.output<typeof schema>;
