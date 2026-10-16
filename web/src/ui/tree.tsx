import { useState } from 'react';
import { z } from 'zod';
import { FileIcon } from '../FileTree.tsx';
import { Card } from './card.tsx';
import { defineUi, text } from './define.ts';
import { EASE_OUT, rise, type Stage } from './motion.ts';
import { StatusMark, statusOf, type Status } from './files.tsx';

type T = { id: string; name: string; note?: string; st?: Status; hl: boolean; open?: boolean; dir: boolean; kids: T[] };

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

const schema = z
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
type Data = z.output<typeof schema>;

// File trees get icons; any other hierarchy gets plain chevrons and dots.
const filey = (list: T[]): boolean => list.some((n) => /\.\w{1,8}$/.test(n.name) || (n.dir && !n.kids.length) || filey(n.kids));

const CHEV = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" /></svg>
);

// Branches unfold top-down: rows drop in, in reading order, while each guide line grows down its branch.
const enter: Stage = (root) => {
  const rows = [...root.querySelectorAll('.ub-tr-row')];
  const step = Math.min(32, 560 / Math.max(1, rows.length));
  const at = new Map(rows.map((r, i) => [r, i * step]));
  return [
    ...rise(rows, { delay: (el) => at.get(el) ?? 0, duration: 280 }, -5),
    ...Array.from(root.querySelectorAll('.ub-tr-g'), (g) => {
      const inner = g.parentElement!.querySelectorAll('.ub-tr-row');
      const first = at.get(inner[0]) ?? 0;
      return g.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], {
        delay: first, duration: Math.min(620, inner.length * step + 180), easing: EASE_OUT, fill: 'backwards',
      });
    }),
  ];
};

function Level({ list, icons, closed, fresh, flip }: { list: T[]; icons: boolean; closed: Set<string>; fresh: Set<string>; flip: (id: string) => void }) {
  return (
    <ul>
      {list.map((n) => {
        const parent = n.kids.length > 0;
        const open = parent && !closed.has(n.id);
        const inner = (
          <>
            {icons ? <FileIcon name={n.name} dir={n.dir} open={open} /> : !parent && <span className="ub-tr-dot" aria-hidden="true" />}
            <span className="ub-tr-nm">{n.name}</span>
            {n.note && <span className="ub-tr-note">{n.note}</span>}
            {n.st && <StatusMark s={n.st} />}
          </>
        );
        return (
          <li key={n.id}>
            {parent ? (
              <button type="button" className={`ub-tr-row${n.hl ? ' ub-tr-hl' : ''}`} aria-expanded={open} onClick={() => flip(n.id)}>
                <span className="ub-tr-chev">{CHEV}</span>
                {inner}
              </button>
            ) : (
              <div className={`ub-tr-row${n.hl ? ' ub-tr-hl' : ''}`}>
                <span className="ub-tr-chev" />
                {inner}
              </div>
            )}
            {open && (
              <div className={fresh.has(n.id) ? 'ub-tr-kids new' : 'ub-tr-kids'}>
                <i className="ub-tr-g" aria-hidden="true" />
                <Level list={n.kids} icons={icons} closed={closed} fresh={fresh} flip={flip} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Tree({ b }: { b: Data }) {
  const [closed, setClosed] = useState(() => {
    const s = new Set<string>();
    const walk = (list: T[]) => list.forEach((n) => (n.open === false && n.kids.length && s.add(n.id), walk(n.kids)));
    walk(b.nodes);
    return s;
  });
  // Branches the user opened fade in; the entrance owns everything rendered on mount.
  const [fresh, setFresh] = useState(() => new Set<string>());
  const flip = (id: string) => {
    const opening = closed.has(id);
    setClosed((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    if (opening) setFresh((s) => new Set(s).add(id));
  };
  return (
    <Card title={b.title} label="Tree" stage={enter} className="ub-tr">
      <div className="ub-tr-wrap">
        <Level list={b.nodes} icons={filey(b.nodes)} closed={closed} fresh={fresh} flip={flip} />
      </div>
    </Card>
  );
}

export const tree = defineUi({ schema, Component: Tree, label: 'Building tree…' });
