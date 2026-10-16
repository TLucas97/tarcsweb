import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { tilde } from '../bits.tsx';
import type { ChangeCard } from '../../../server/protocol.ts';
import { FileIcon, openFile } from '../FileTree.tsx';
import { openDiff } from '../Focus.tsx';
import { currentSummary, useStore } from '../store.ts';
import { Card } from './card.tsx';
import { defineUi, text } from './define.ts';
import { fade, rise, type Stage } from './motion.ts';

export type Status = 'added' | 'modified' | 'deleted' | 'renamed';
export const STATUS: Record<Status, { letter: string; label: string }> = {
  added: { letter: 'A', label: 'Added' },
  modified: { letter: 'M', label: 'Modified' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
};
const ALIAS: Record<string, Status> = {
  a: 'added', add: 'added', added: 'added', new: 'added', create: 'added', created: 'added',
  m: 'modified', mod: 'modified', modified: 'modified', change: 'modified', changed: 'modified', edit: 'modified', edited: 'modified', update: 'modified', updated: 'modified',
  d: 'deleted', del: 'deleted', delete: 'deleted', deleted: 'deleted', remove: 'deleted', removed: 'deleted',
  r: 'renamed', rename: 'renamed', renamed: 'renamed', move: 'renamed', moved: 'renamed',
};
export const statusOf = (s?: string) => (s ? ALIAS[s.trim().toLowerCase()] : undefined);

export function StatusMark({ s }: { s: Status }) {
  return <span className={`ub-fl-st ${s}`} title={STATUS[s].label}>{STATUS[s].letter}<span className="ub-sr"> {STATUS[s].label}</span></span>;
}

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
const schema = z.preprocess(
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
type Data = z.output<typeof schema>;

// "src/a.ts:42" carries its line.
const LINE = /^(.*?):(\d+)(?::\d+)?$/;
function split(raw: string, line?: number) {
  const m = LINE.exec(raw.trim());
  return m ? { path: m[1], line: line ?? Number(m[2]) } : { path: raw.trim(), line };
}

const enter: Stage = (root) => {
  const rows = root.querySelectorAll('.ub-fl-r');
  const step = Math.min(40, 480 / Math.max(1, rows.length));
  const at = (el: Element) => Number((el.closest('.ub-fl-r') as HTMLElement | null)?.dataset.i ?? 0) * step;
  return [
    ...rise(rows, { stagger: step, duration: 300 }, 4),
    ...fade(root.querySelectorAll('.ub-fl-ct, .ub-fl-st'), { delay: (el) => at(el) + 140, duration: 240 }),
    ...fade(root.querySelectorAll('.ub-fl-sum'), { delay: rows.length * step + 120, duration: 260 }),
  ];
};

// The newest diff card in this session that touched the path; read on click, so the block never subscribes to cards.
function cardFor(path: string) {
  const s = useStore.getState();
  if (!s.current) return null;
  const pos = new Map(s.order.map((id, i) => [id, i]));
  const same = (a: string) => a === path || a.endsWith(`/${path}`) || path.endsWith(`/${a}`);
  let best: { item: string; card: ChangeCard } | null = null;
  let at = -1;
  for (const refs of Object.values(s.cardsOf)) {
    for (const [item, card] of refs) {
      const i = pos.get(item) ?? -1;
      if (i >= at && card.files.some((f) => same(f.path))) (at = i), (best = { item, card });
    }
  }
  return best && { sessionId: s.current, ...best };
}

function Files({ b }: { b: Data }) {
  const cwd = useStore((s) => currentSummary(s)?.cwd ?? '');
  const home = useStore((s) => s.home);
  const [miss, setMiss] = useState<number | null>(null);
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  const rows = b.items.map((f) => ({ ...f, ...split(f.path, f.line), st: statusOf(f.status) }));
  const add = rows.reduce((a, f) => a + (f.add ?? 0), 0);
  const del = rows.reduce((a, f) => a + (f.del ?? 0), 0);
  const shown = (p: string) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : tilde(p, home));
  const label = `${rows.length} ${rows.length === 1 ? 'file' : 'files'}`;
  return (
    <Card
      title={b.title} label={label} stage={enter} className="ub-fl"
      head={(add > 0 || del > 0) ? (
        <span className="ub-fl-sum" aria-label={`${add} lines added, ${del} removed`}>
          {b.title && <span className="ub-fl-n">{label}</span>}
          {add > 0 && <span className="add">+{add}</span>}
          {del > 0 && <span className="del">−{del}</span>}
        </span>
      ) : undefined}
    >
      <ul className="ub-fl-list">
        {rows.map((f, i) => {
          const p = shown(f.path);
          const cut = p.lastIndexOf('/', p.length - 2);
          const dir = cut >= 0 ? p.slice(0, cut + 1) : '';
          const base = p.slice(cut + 1);
          const gone = f.st === 'deleted';
          const body = (
            <>
              <FileIcon name={base.replace(/\/$/, '')} dir={base.endsWith('/')} open={false} />
              <span className="ub-fl-p">
                {dir && <span className="ub-fl-dir">{dir}</span>}
                <span className="ub-fl-nm">{base}</span>
                {f.line !== undefined && <span className="ub-fl-ln">:{f.line}</span>}
              </span>
              {(f.add !== undefined || f.del !== undefined) && (
                <span className="ub-fl-ct">
                  {f.add !== undefined && <span className="add">+{f.add}</span>}
                  {f.del !== undefined && <span className="del">−{f.del}</span>}
                </span>
              )}
              {f.st && <StatusMark s={f.st} />}
              {miss === i ? <span className="ub-fl-note miss" role="status">Not in this session's folder</span> : f.note && <span className="ub-fl-note">{f.note}</span>}
            </>
          );
          return (
            <li key={i} className="ub-fl-r" data-i={i}>
              {gone ? (
                <div className={`ub-fl-b ${f.st}`}>{body}</div>
              ) : (
                <button
                  type="button" className={`ub-fl-b${f.st ? ` ${f.st}` : ''}`} title={`Open ${p}${f.line ? `:${f.line}` : ''}`}
                  onClick={(e) => {
                    // A changed file opens its diff, like the diff cards; anything else opens the file.
                    const c = f.st && cardFor(f.path);
                    if (c) return openDiff({ sessionId: c.sessionId, item: c.item, card: c.card.id }, c.card.name, e.currentTarget);
                    if (openFile(f.path, f.line, e.currentTarget)) return;
                    setMiss(i);
                    clearTimeout(t.current);
                    t.current = window.setTimeout(() => setMiss(null), 2400);
                  }}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export const files = defineUi({ schema, Component: Files, label: 'Listing files…' });
