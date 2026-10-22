import { z } from 'zod';
import { text } from './loose.ts';

const side = z.union([
  text.transform((code) => ({ code, label: undefined as string | undefined, lang: undefined as string | undefined })),
  z.object({ code: text.optional(), text: text.optional(), label: text.optional(), lang: text.optional() })
    .transform((s) => ({ code: s.code ?? s.text ?? '', label: s.label, lang: s.lang })),
]);
export const schema = z.object({
  title: z.string().optional(),
  lang: text.optional(),
  before: side,
  after: side,
  note: text.optional(),
});
export type Data = z.output<typeof schema>;
