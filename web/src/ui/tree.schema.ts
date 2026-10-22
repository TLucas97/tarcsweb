import { z } from 'zod';
import { statusOf, type Status } from './files.schema.ts';
import { text } from './loose.ts';

export type T = { id: string; name: string; note?: string; st?: Status; hl: boolean; open?: boolean; dir: boolean; kids: T[] };

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);
// "src/ — sources" and "a.ts # entry" carry a note after the name.
const NOTE = /^(.*?)\s+(?:—|#)\s+(.*)$/;

function leaf(name: string, extra: Partial<T> = {}): T {
  const m = NOTE.exec(name);
  const nm = (m ? m[1] : name).trim();
  return { id: '', name: nm.replace(/\/$/, ''), note: m?.[2], hl: false, dir: nm.endsWith('/'), kids: [], ...extra };
}

// Puts a/b/c under existing a and b when they are already there.
function insert(into: T[], parts: string[], node: T) {
  if (parts.length === 1) {
    const same = into.find((x) => x.name === node.name && (x.kids.length || x.dir));
    if (same && (node.kids.length || node.dir)) same.kids.push(...node.kids);
    else into.push(node);
    return;
  }
  let dir = into.find((x) => x.name === parts[0]);
  if (!dir) into.push((dir = leaf(`${parts[0]}/`)));
  dir.dir = true;
  insert(dir.kids, parts.slice(1), node);
}

function nodesOf(raw: unknown): T[] {
  const out: T[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    // {"src": {"a.ts": "entry"}}: keys are names, objects are folders, strings are notes.
    for (const [k, v] of Object.entries(raw)) {
      const kids = v && typeof v === 'object' ? nodesOf(v) : [];
      out.push(leaf(k, { note: str(v), dir: kids.length > 0 || k.endsWith('/'), kids }));
    }
    return out;
  }
  if (!Array.isArray(raw)) return out;
  for (const x of raw) {
    const s = str(x);
    if (s !== undefined) {
      const n = leaf(s);
      const parts = n.name.split('/').filter(Boolean);
      if (parts.length) insert(out, parts, { ...n, name: parts.at(-1)! });
      continue;
    }
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const name = str(o.name ?? o.label ?? o.title ?? o.path);
    if (!name) continue;
    const kids = nodesOf(o.children ?? o.items ?? o.nodes ?? o.files);
    const open = typeof o.open === 'boolean' ? o.open : typeof o.expanded === 'boolean' ? o.expanded : typeof o.collapsed === 'boolean' ? !o.collapsed : undefined;
    out.push({ ...leaf(name), note: str(o.note ?? o.desc ?? o.comment) ?? leaf(name).note, st: statusOf(str(o.status)), hl: !!(o.hl ?? o.highlight), open, dir: kids.length > 0 || name.endsWith('/'), kids });
  }
  return out;
}

export const schema = z
  .object({
    title: z.string().optional(),
    root: text.optional(),
    items: z.unknown().optional(),
    nodes: z.unknown().optional(),
    tree: z.unknown().optional(),
    paths: z.array(text).optional(),
    depth: z.coerce.number().int().min(0).optional(),
  })
  .transform((b) => {
    let nodes = nodesOf(b.items ?? b.nodes ?? b.tree ?? b.paths ?? []);
    if (b.root) nodes = [{ ...leaf(String(b.root)), dir: true, kids: nodes }];
    const total = { n: 0 };
    const ids = (list: T[], at: string, depth: number) => list.forEach((n, i) => {
      n.id = `${at}/${i}`;
      total.n++;
      if (n.open === undefined) n.open = b.depth === undefined || depth < b.depth;
      ids(n.kids, n.id, depth + 1);
    });
    ids(nodes, '', 0);
    return { title: b.title, nodes, total: total.n };
  })
  .refine((b) => b.total > 0, 'needs at least one node');
export type Data = z.output<typeof schema>;
