import { z } from 'zod';
import { loose, text } from './loose.ts';

export const schema = loose(
  z.object({ title: text.refine((t) => t.trim().length > 0, { message: 'needs a title' }) }),
  { title: ['topic', 'heading', 'name', 'text', 'label'] },
);
export type Data = z.output<typeof schema>;
