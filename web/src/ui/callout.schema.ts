import { z } from 'zod';
import { loose, text } from './loose.ts';

export type Tone = 'note' | 'tip' | 'warning' | 'risk';
const TONES: Record<string, Tone> = {
  note: 'note', info: 'note', neutral: 'note',
  tip: 'tip', hint: 'tip', success: 'tip', good: 'tip',
  warning: 'warning', warn: 'warning', caution: 'warning', important: 'warning',
  risk: 'risk', danger: 'risk', error: 'risk', critical: 'risk', bad: 'risk',
};
const tone = z.preprocess((v) => {
  const k = String(v).trim().toLowerCase();
  return Object.hasOwn(TONES, k) ? TONES[k] : 'note';
}, z.enum(['note', 'tip', 'warning', 'risk']));

export const schema = loose(
  z
    .object({ tone, title: text.optional(), body: z.union([text, z.array(text)]).optional() })
    .refine((b) => b.title || b.body, { message: 'needs a title or a body' }),
  { tone: ['kind', 'variant', 'level'], body: ['text', 'message', 'content', 'detail', 'description'] },
);
export type Data = z.output<typeof schema>;
