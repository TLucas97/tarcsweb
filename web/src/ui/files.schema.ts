import { z } from 'zod';
import { text } from './loose.ts';

export type Status = 'added' | 'modified' | 'deleted' | 'renamed';
const ALIAS: Record<string, Status> = {
  a: 'added', add: 'added', added: 'added', new: 'added', create: 'added', created: 'added',
  m: 'modified', mod: 'modified', modified: 'modified', change: 'modified', changed: 'modified', edit: 'modified', edited: 'modified', update: 'modified', updated: 'modified',
  d: 'deleted', del: 'deleted', delete: 'deleted', deleted: 'deleted', remove: 'deleted', removed: 'deleted',
  r: 'renamed', rename: 'renamed', renamed: 'renamed', move: 'renamed', moved: 'renamed',
};
export const statusOf = (s?: string) => (s ? ALIAS[s.trim().toLowerCase()] : undefined);

const n = z.coerce.number().int().nonnegative().optional().catch(undefined);
const item = z.union([
  text.transform((path) => ({ path, status: undefined, add: undefined, del: undefined, line: undefined, note: undefined })),
  z.object({
    path: text.optional(), file: text.optional(), name: text.optional(), status: text.optional(),
    add: n, additions: n, insertions: n, plus: n, del: n, deletions: n, removals: n, minus: n,
    line: n, note: text.optional(), why: text.optional(),
  }).transform((f) => ({
    path: f.path ?? f.file ?? f.name ?? '', status: f.status, add: f.add ?? f.additions ?? f.insertions ?? f.plus,
    del: f.del ?? f.deletions ?? f.removals ?? f.minus, line: f.line, note: f.note ?? f.why,
  })),
]);
export const schema = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    return { ...o, items: o.items ?? o.files ?? o.paths };
  },
  z.object({
    title: z.string().optional(),
    items: z.array(item).max(60).transform((a) => a.filter((f) => f.path)).refine((a) => a.length > 0, 'needs at least one path'),
  }),
);
export type Data = z.output<typeof schema>;
