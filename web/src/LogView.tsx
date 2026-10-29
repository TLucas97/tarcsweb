import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type UIEvent } from 'react';
import { appendComposer } from './PluginBand.tsx';
import { SendIcon } from './SendToChat.tsx';
import { flatLines, parseMore, rawOf, type Field, type Level, type LogGroup, type LogLine, type LogNode } from './logParse.ts';

export type LogFilter = 'all' | 'warn' | 'error';
const RANK: Record<Level, number> = { error: 3, warn: 2, info: 1, debug: 0 };
const TAG: Record<Level, string> = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' };
const ADDED_MS = 1200;
const MAX_QUOTE = 6000;

// Every node gets a path id ("2.0.1"), so a selection can map back to the raw lines behind it.
function index(nodes: LogNode[], prefix = '', out = new Map<string, LogNode>()) {
  nodes.forEach((n, i) => {
    const id = prefix + i;
    out.set(id, n);
    if (n.kind === 'group') index(n.children, `${id}.`, out);
  });
  return out;
}

const Fields = ({ fields }: { fields: Field[] }) =>
  fields.length ? (
    <span className="lg-f">
      {fields.map((f, i) => (
        <span key={i}>{f.k && <>{f.k.split('.').pop()} </>}<i>{f.v}</i></span>
      ))}
    </span>
  ) : null;

// Memo: a refresh keeps the node objects of unchanged rows, so only new or merged rows render. trail is a string for the same reason.
const Line = memo(function Line({ n, id, trail }: { n: LogLine; id: string; trail?: string }) {
  return (
    <div className={`lg-r${n.level ? ` ${n.level}` : ''}`} data-k={id}>
      <span className={`lg-lv${n.level ? '' : ' none'}`}>{n.level ? TAG[n.level] : ''}</span>
      <span className="lg-m">
        {trail && <span className="lg-trail">{trail} › </span>}
        {n.msg}
      </span>
      <Fields fields={n.fields} />
      {n.count > 1 && <span className="lg-n">×{n.count}</span>}
    </div>
  );
});

const summary = (g: LogGroup) => {
  const ok = !g.worst || RANK[g.worst] < RANK.warn;
  return `${g.count > 1 ? `ran ${g.count}× · ` : ''}${ok ? 'all fine' : g.worst === 'error' ? 'has errors' : 'has warnings'}`;
};

function Group({ g, id, open, toggle }: { g: LogGroup; id: string; open: (g: LogGroup, id: string) => boolean; toggle: (id: string, on: boolean) => void }) {
  const on = open(g, id);
  const empty = !g.children.length;
  return (
    <div className="lg-gw">
      <div
        className={`lg-g${g.worst && RANK[g.worst] >= RANK.warn ? ` ${g.worst}` : ''}`} data-k={id}
        {...(empty ? {} : {
          role: 'button', tabIndex: 0, 'aria-expanded': on,
          // A drag that selected text in the row is not a click.
          onClick: () => void (getSelection()?.toString() || toggle(id, !on)),
          onKeyDown: (e: KeyboardEvent) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            toggle(id, !on);
          },
        })}
      >
        <span className="lg-c" aria-hidden="true">
          {!empty && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </span>
        <span className="lg-t">{g.title}</span>
        <Fields fields={g.fields} />
        {!on && !empty && (
          <span className="lg-sum">
            {summary(g)}
            {g.last.length > 0 && <> · last <Fields fields={g.last} /></>}
          </span>
        )}
        {g.count > 1 && <span className="lg-n">×{g.count}</span>}
      </div>
      {on && !empty && <div className="lg-kid"><Nodes nodes={g.children} prefix={`${id}.`} open={open} toggle={toggle} /></div>}
    </div>
  );
}

function Nodes({ nodes, prefix, open, toggle }: { nodes: LogNode[]; prefix: string; open: (g: LogGroup, id: string) => boolean; toggle: (id: string, on: boolean) => void }) {
  return nodes.map((n, i) => (n.kind === 'line' ? <Line key={i} n={n} id={prefix + i} /> : <Group key={i} g={n} id={prefix + i} open={open} toggle={toggle} />));
}

// The readable log: events as rows, spans as groups that fold, repeats counted, a filter by level and the raw text a click away.
// lead: controls shown first in the bar, such as the source picker.
export default function LogView({ text, cut, loading, name, scrollRef, onScroll, lead }: {
  text: string; cut: boolean; loading: boolean; name: string; scrollRef: Ref<HTMLElement>; onScroll: (e: UIEvent<HTMLElement>) => void; lead?: ReactNode;
}) {
  const [raw, setRaw] = useState(false);
  const [filter, setFilter] = useState<LogFilter>('all');
  // Growing text parses only its new lines; set during render so the rows never show a stale parse.
  const [parsed, setParsed] = useState(() => parseMore(null, text, cut));
  if (parsed.text !== text || parsed.cut !== cut) setParsed(parseMore(parsed, text, cut));
  const nodes = parsed.nodes;
  const ids = useMemo(() => index(nodes), [nodes]);
  const flat = useMemo(() => flatLines(nodes), [nodes]);
  let warns = 0;
  let errors = 0;
  for (const l of flat) {
    if (l.line.level === 'warn') warns++;
    else if (l.line.level === 'error') errors++;
  }
  // Folding is remembered per title path, since ids shift as the tail moves.
  const [folds, setFolds] = useState<Map<string, boolean>>(() => new Map());
  const titleOf = (id: string) => id.split('.').map((_, i, a) => { const n = ids.get(a.slice(0, i + 1).join('.')); return n?.kind === 'group' ? n.title : ''; }).join('/');
  const open = (g: LogGroup, id: string) => {
    const saved = folds.get(titleOf(id));
    if (saved !== undefined) return saved;
    // Trouble and the newest top-level run start open; everything else starts folded.
    return (!!g.worst && RANK[g.worst] >= RANK.warn) || id === String(nodes.length - 1);
  };
  const toggle = (id: string, on: boolean) => setFolds((m) => new Map(m).set(titleOf(id), on));

  const rows = filter === 'all' ? null : flat.filter((l) => l.line.level && RANK[l.line.level] >= RANK[filter]);
  const chip = (f: LogFilter, label: string, n: number) => (
    <button type="button" className={`lg-chip${f === 'warn' ? ' w' : f === 'error' ? ' e' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
      {label} <span>{n}</span>
    </button>
  );
  return (
    <>
      <div className="lg-bar">
        {lead}
        {!raw && (warns > 0 || errors > 0) && <>{chip('all', 'All', flat.length)}{warns > 0 && chip('warn', 'Warnings', warns)}{errors > 0 && chip('error', 'Errors', errors)}</>}
        <button type="button" className="lg-raw" aria-pressed={raw} onClick={() => setRaw(!raw)} title={raw ? 'Show the readable log' : 'Show the output exactly as printed'}>Raw</button>
      </div>
      <div className="lg-wrap">
        {raw || loading ? (
          <pre className="logbody mono" ref={scrollRef as Ref<HTMLPreElement>} onScroll={onScroll}>{loading ? 'Loading…' : text}</pre>
        ) : (
          <div className="logbody lg" ref={scrollRef as Ref<HTMLDivElement>} onScroll={onScroll}>
            {rows
              ? rows.map((r, i) => <Line key={i} n={r.line} id={`f${i}`} trail={r.trail.join(' › ')} />)
              : <Nodes nodes={nodes} prefix="" open={open} toggle={toggle} />}
            {rows && !rows.length && <div className="lg-none">No {filter === 'warn' ? 'warnings' : 'errors'} in this part of the log</div>}
          </div>
        )}
        <SendSelection name={name} rawFor={raw ? null : (range, host) => {
        const picked: string[] = [];
        for (const el of host.querySelectorAll<HTMLElement>('.lg [data-k]')) {
          if (!range.intersectsNode(el)) continue;
          const k = el.dataset.k!;
          const n = k.startsWith('f') ? rows?.[Number(k.slice(1))]?.line : ids.get(k);
          if (!n) continue;
          // An open group's children are picked on their own; a folded one brings its whole body.
          picked.push(n.kind === 'group' && open(n, k) ? n.raw : rawOf(n));
        }
        return picked.join('\n');
      }} />
      </div>
    </>
  );
}

type Spot = { left: number; top: number };

// "Send to chat" next to a selection inside the log; the raw lines go in, not the tidied rows.
export function SendSelection({ name, rawFor }: { name: string; rawFor: ((range: Range, host: Element) => string) | null }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [added, setAdded] = useState(false);
  // While "Added" shows, the cleared selection must not hide the button.
  const hold = useRef(false);

  useEffect(() => {
    let timer = 0;
    const check = () => {
      if (hold.current) return;
      const sel = getSelection();
      const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      const host = range && (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('.lg-wrap');
      if (!range || !host || !sel!.toString().trim()) return setSpot(null);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const box = host.getBoundingClientRect();
      setSpot({ left: Math.max(8, Math.min(last.right - box.left - 60, box.width - 140)), top: Math.min(last.bottom - box.top + 6, box.height - 38) });
    };
    const onSelect = () => {
      clearTimeout(timer);
      timer = window.setTimeout(check, 120);
    };
    document.addEventListener('selectionchange', onSelect);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelect);
    };
  }, []);

  useEffect(() => {
    if (!added) return;
    const t = window.setTimeout(() => {
      hold.current = false;
      setAdded(false);
      setSpot(null);
    }, ADDED_MS);
    return () => clearTimeout(t);
  }, [added]);

  if (!spot) return null;
  const go = () => {
    const sel = getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    const host = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('.lg-wrap');
    let body = ((host && rawFor?.(range, host)) || sel.toString()).replace(/^\n+|\s+$/g, '');
    if (body.length > MAX_QUOTE) body = `…${body.slice(-MAX_QUOTE)}`;
    const fence = body.includes('```') ? '~~~' : '```';
    if (!appendComposer(`From the log of "${name}":\n${fence}\n${body}\n${fence}\n\n`)) return;
    hold.current = true;
    sel.removeAllRanges();
    setAdded(true);
  };
  return (
    <button type="button" className="xbtn lg-send" style={{ left: spot.left, top: spot.top }} onPointerDown={(e) => e.preventDefault()} onClick={go} title="Quote the selected lines in your message">
      <SendIcon />
      <span aria-live="polite">{added ? 'Added' : 'Send to chat'}</span>
    </button>
  );
}
