import { z } from 'zod';
import { text } from './loose.ts';

const nodeIn = z.union([
  text.transform((id) => ({ id, label: id, sub: undefined as string | undefined })),
  z.object({ id: text.optional(), label: text.optional(), name: text.optional(), title: text.optional(), sub: text.optional(), note: text.optional() })
    .transform((n) => ({ id: n.id ?? n.label ?? n.name ?? n.title ?? '', label: n.label ?? n.name ?? n.title ?? n.id ?? '', sub: n.sub ?? n.note })),
]);
const edgeIn = z.union([
  z.array(text).min(2).max(3).transform(([from, to, label]) => ({ from, to, label, accent: false })),
  z.object({ from: text.optional(), source: text.optional(), to: text.optional(), target: text.optional(), label: text.optional(), accent: z.boolean().optional() })
    .transform((e) => ({ from: e.from ?? e.source ?? '', to: e.to ?? e.target ?? '', label: e.label, accent: !!e.accent })),
]);
export const schema = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    return { ...o, edges: o.edges ?? o.links ?? o.arrows };
  },
  z.object({
    title: z.string().optional(),
    nodes: z.array(nodeIn).max(40).default([]),
    edges: z.array(edgeIn).max(80).default([]),
    accent: z.array(text).optional(),
    direction: z.enum(['LR', 'TB', 'right', 'down']).optional(),
  }).refine((d) => d.nodes.length + d.edges.length > 0, 'needs nodes or edges'),
);
export type Data = z.output<typeof schema>;
