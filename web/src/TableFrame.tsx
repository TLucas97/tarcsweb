import type { TableSpec } from '../../server/protocol.ts';
import { Pending } from './bits.tsx';
import { FxBtn } from './Focus.tsx';
import { mdTable, SendTextBtn } from './SendToChat.tsx';

// Shared by show_table's card (Rich.tsx) and its fenced fallback (Markdown.tsx), which cannot import Rich without a cycle.

const NUM = /^[-+−]?[$€£]?[\d.,]+\s*[%a-zµ]*$/i;
function pill(text: string) {
  if (/^(passed|pass|ok|success)$/i.test(text)) return <span className="pill ok">{text}</span>;
  if (/^(failed|fail|error)$/i.test(text)) return <span className="pill f">{text}</span>;
  if (/^(skipped|skip|pending)$/i.test(text)) return <span className="pill sk">{text}</span>;
  return text;
}

// show_table's args written as a ```mcp__app__show_table fence instead of a call; same caps as tableSpec in server/tools.ts.
export function fencedTable(body: string): TableSpec | null {
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const { title, note, columns, rows, align } = o as Record<string, unknown>;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return null;
  const cell = (c: unknown) => (c === null || c === undefined ? '' : typeof c === 'object' ? JSON.stringify(c) : String(c)).slice(0, 300);
  return {
    title: typeof title === 'string' ? (title.length > 120 ? `${title.slice(0, 119)}…` : title) : '',
    note: typeof note === 'string' ? note.slice(0, 80) : '',
    columns: columns.slice(0, 12).map(cell),
    rows: rows.slice(0, 200).map((r) => (Array.isArray(r) ? r.slice(0, 12).map(cell) : [])),
    align: Array.isArray(align) ? align.slice(0, 12).map((a) => (a === 'right' || a === 'center' ? a : 'left')) : [],
  };
}

const tableText = (t: TableSpec) => {
  const head = [t.title && `**${t.title}**`, t.note && `(${t.note})`].filter(Boolean).join(' ');
  return `${head ? `${head}\n\n` : ''}${mdTable(t.columns, t.rows, t.align)}`;
};

export function TableFrame({ t, id }: { t: TableSpec; id?: string }) {
  const numeric = t.columns.map((_, i) => {
    const cells = t.rows.map((r) => r[i] ?? '').filter((c) => c && c !== '—' && c !== '-');
    return cells.length > 0 && cells.every((c) => NUM.test(c.trim()));
  });
  const cls = (i: number) => (t.align[i] === 'right' || (!t.align[i] && numeric[i]) ? 'num' : t.align[i] === 'center' ? 'mid' : undefined);
  const send = t.columns.length > 0 && <SendTextBtn text={() => tableText(t)} what="the table" />;
  return (
    <div className="frame" data-id={id}>
      {t.title || t.note ? (
        <div className="fh"><span className="n">{t.title}</span>{t.note && <span className="end">{t.note}</span>}{send}<FxBtn label={t.title || 'Table'} /></div>
      ) : (
        <div className="ub-acts">{send}<FxBtn label="Table" /></div>
      )}
      {!t.columns.length && <div className="vmsg"><Pending text="Building the table…" /></div>}
      <div className="tscroll">
        <table className="tbl">
          <thead><tr>{t.columns.map((c, i) => <th key={i} className={cls(i)}>{c}</th>)}</tr></thead>
          <tbody>
            {t.rows.map((r, j) => <tr key={j}>{t.columns.map((_, i) => <td key={i} className={cls(i)}>{pill(r[i] ?? '')}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
