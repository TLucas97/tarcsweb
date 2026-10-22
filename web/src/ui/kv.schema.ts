import { z } from 'zod';
import { fact, loose, text } from './loose.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const row = loose(
  z.object({ key: text, value: z.preprocess((v) => v ?? '—', fact), hint: text.optional() }),
  { key: ['k', 'label', 'name', 'term'], value: ['v', 'val', 'definition'], hint: ['note', 'detail'] },
);
// Rows come as [{key, value}], [[key, value]] or a plain {key: value} object.
const rows = z.preprocess(
  (v) => (Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? { key: x[0], value: x[1] } : x)) : isRecord(v) ? Object.entries(v).map(([key, value]) => ({ key, value })) : v),
  z.array(row),
);
const group = loose(z.object({ title: text.optional(), items: rows }), { title: ['name', 'label'], items: ['rows', 'facts', 'entries'] });
export const schema = loose(
  z
    .object({
      title: z.string().optional(),
      items: rows.optional(),
      groups: z.preprocess((v) => (isRecord(v) ? Object.entries(v).map(([title, items]) => ({ title, items })) : v), z.array(group)).optional(),
    })
    .refine((b) => b.items?.length || b.groups?.some((g) => g.items.length), { message: 'needs items or groups' }),
  { items: ['rows', 'facts', 'entries', 'data'] },
);
export type Data = z.output<typeof schema>;
