import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChartSpec, ChoiceSpec, RichDetail, TableSpec } from '../../server/protocol.ts';
import { openReplay, pickChoiceLocal, useStore, type RichItem } from './store.ts';
import { send } from './socket.ts';
import { Pending, reduceMotion } from './bits.tsx';
import { FxBtn } from './Focus.tsx';
import { usePageDoc } from './Replay.tsx';
import { sign } from './LocalImage.tsx';
import { SendImageBtn } from './SendToChat.tsx';
import { useWidth } from './ui/size.ts';
import { watchNear } from './near.ts';
import { isNarrow } from './narrow.ts';
import { Round } from './Round.tsx';

type Of<K extends RichDetail['kind']> = Extract<RichDetail, { kind: K }>;

// The visual mod's base stylesheet, placed first so the agent's own CSS wins (same as its renderer).
const BASE_CSS = `:root{color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%;background:#ffffff;color:#1a1a1a;overflow:hidden}
body{padding:16px;font:18px/1.45 "Atkinson Hyperlegible",system-ui,sans-serif}`;

function compose(html: string, title: string) {
  const head = `<meta charset="utf-8"><title>${(title || 'visual').replace(/</g, '&lt;')}</title><style id="visual-base">${BASE_CSS}</style>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${head}`);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

// Scale that fits a fixed canvas into the conversation column.
const colOf = (el: HTMLDivElement) => el.closest('.col');
function useFit(width: number) {
  const [ref, cw] = useWidth(colOf);
  return [ref, cw > 0 ? Math.min(1, (cw - 2) / width) : 1] as const;
}

function Visual({ item }: { item: RichItem }) {
  const d = item.detail as Of<'visual'>;
  const [run, setRun] = useState(0);
  const [ref, k] = useFit(d.width);
  const ready = !item.partial && !!d.html;
  // Each iframe is a document of its own: load it only near the viewport, then keep it.
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!ready || near) return;
    return watchNear(ref.current!, () => setNear(true));
  }, [ready, near, ref]);
  const err = item.result?.error;
  const png = item.result?.png;
  return (
    <div className="frame vframe" data-id={item.id} ref={ref}>
      <div className="fh">
        <span className="tool mono">render_ui</span>
        <span className="n">{d.title || 'Visual'}</span>
        {item.seen && <span className="seen">Picture checked</span>}
        {ready && <button className="btnx end" onClick={() => setRun(run + 1)} title="Play the animation again">Replay ↻</button>}
        {ready && png && <SendImageBtn src={() => sign(png)} name={d.title || 'Visual'} className="btnx" />}
        {ready && <FxBtn label={d.title || 'Visual'} />}
      </div>
      {err ? (
        <div className="vmsg bad">{err}</div>
      ) : (
        <div className="vbox" style={{ width: d.width * k, height: d.height * k }}>
          {ready ? near && (
            <iframe
              key={run} className="live-vis" sandbox="allow-scripts" title={d.title || 'Visual'} srcDoc={compose(d.html, d.title)}
              width={d.width} height={d.height} style={k < 1 ? { transform: `scale(${k})`, transformOrigin: '0 0' } : undefined}
            />
          ) : (
            <div className="vmsg"><span className="think">Drawing…</span></div>
          )}
        </div>
      )}
    </div>
  );
}

function ReplayCard({ item }: { item: RichItem }) {
  const d = item.detail as Of<'replay'>;
  const sessionId = useStore((s) => s.current);
  const key = `${sessionId}:${item.id}`;
  const info = useStore((s) => s.replays[key]);
  useEffect(() => {
    if (!info && !item.partial && sessionId) send({ type: 'replay-load', sessionId, id: item.id });
  }, [info, item.partial, sessionId, item.id]);
  const pages = info?.pages ?? [];
  const start = Math.min(Math.max(0, d.page - 1), Math.max(0, pages.length - 1));
  const open = (page: number) => pages.length && openReplay({ key, page });
  const p0 = pages[start];
  const doc = usePageDoc(p0?.url);
  const k = p0 ? Math.min(264 / p0.width, 240 / p0.height) : 0.3;
  return (
    <div className="frame" data-id={item.id}>
      <div className="fh">
        <span className="tool mono">replay</span>
        <span className="n">{info?.title || 'Replay'}</span>
        {pages.length > 0 && <span className="end">{pages.length} page{pages.length > 1 ? 's' : ''}</span>}
      </div>
      {info?.error || item.result?.error ? (
        <div className="vmsg bad">{info?.error || item.result?.error}</div>
      ) : !info ? (
        <div className="vmsg"><span className="think">Loading the replay…</span></div>
      ) : (
        <div className="rpcard">
          <div
            className="thumb" role="button" tabIndex={0} aria-label="Open replay" onClick={() => open(start)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(start))}
          >
            {p0 && doc?.html && <iframe sandbox="allow-scripts" tabIndex={-1} title="Page preview" srcDoc={doc.html} style={{ width: p0.width, height: p0.height, transform: `scale(${k})` }} />}
          </div>
          <div className="pages">
            <div className="plist">
              {pages.map((p, i) => <button key={i} onClick={() => open(i)}><b>{p.id}</b>{p.title}</button>)}
            </div>
            <button className="go2" onClick={() => open(start)}>Open replay<kbd>↵</kbd></button>
          </div>
        </div>
      )}
    </div>
  );
}

// "3.2", "1,250", "38%".
const fmt = (v: number, unit = '') => {
  const n = Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(Number(v.toFixed(2)));
  return unit === '%' ? `${n}%` : n;
};
function niceMax(x: number) {
  if (x <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}
const SERIES = ['var(--ink)', 'var(--ser2,#bfb9ab)', 'var(--ser3,#8a8578)', 'var(--ser4,#e0dbcf)'];

export function Legend({ c }: { c: ChartSpec }) {
  if (c.series.length < 2) return null;
  return (
    <span className="legend">
      {c.series.map((s, i) => <span key={i}><i style={{ background: SERIES[i] }}></i>{s.name || `Series ${i + 1}`}</span>)}
    </span>
  );
}

// Narrow windows pass the column width (`room`); the bars and long labels shrink so the chart fits without scrolling.
const clip = (l: string, max: number) => (l.length > max ? `${l.slice(0, max - 1)}…` : l);

export function BarChart({ c, room = 0 }: { c: ChartSpec; room?: number }) {
  const multi = c.series.length > 1;
  const n = c.labels.length || Math.max(0, ...c.series.map((s) => s.values.length));
  const all = c.series.flatMap((s) => s.values);
  const max = Math.max(0, ...all) || 1;
  const top = Math.max(...(c.series[0]?.values ?? [0]));
  const chars = room ? 13 : Infinity;
  const labelW = Math.min(room ? 100 : 170, Math.max(64, Math.max(0, ...c.labels.map((l) => Math.min(chars, l.length))) * 7 + 14));
  // 64 holds the value text, 32 the chart's side margins.
  const W = room ? Math.max(60, Math.min(300, room - labelW - 96)) : 300;
  const barH = multi ? 10 : 14;
  const rowH = multi ? c.series.length * (barH + 3) + 12 : 28;
  return (
    <svg className="chart" width={labelW + W + 64} height={n * rowH + 8}>
      {Array.from({ length: n }, (_, i) => (
        <g key={i}>
          <text x="0" y={i * rowH + (multi ? rowH / 2 + 2 : 18)}>{clip(c.labels[i] ?? '', chars)}</text>
          {c.series.map((s, j) => {
            const v = s.values[i];
            if (v === undefined) return null;
            const w = (Math.max(0, v) / max) * W;
            const y = i * rowH + (multi ? 6 + j * (barH + 3) : 7);
            const fill = multi ? SERIES[j] : v === top ? 'var(--ink)' : 'var(--dot,#d9d4c7)';
            return (
              <g key={j}>
                <rect className="hb" style={{ ['--k' as string]: i }} x={labelW} y={y} width={w} height={barH} rx="3" fill={fill} />
                <text className="v" x={labelW + w + 8} y={y + barH - (multi ? 1 : 3)}>{fmt(v, c.unit)}</text>
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

export function LineChart({ c, animate, room = 0 }: { c: ChartSpec; animate: boolean; room?: number }) {
  // 56 holds the tick labels and padding, 32 the chart's side margins.
  const W = room ? Math.max(160, Math.min(420, room - 88)) : 420;
  const H = 110;
  const n = Math.max(2, c.labels.length, ...c.series.map((s) => s.values.length));
  const all = c.series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const hi = niceMax(Math.max(0, ...all) * 1.05);
  const x = (i: number) => i * (W / (n - 1));
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const ticks = [lo, (lo + hi) / 2, hi];
  const paths = c.series.map((s) => s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '));
  const ref = useRef<SVGPathElement>(null);
  useEffect(() => {
    const l = ref.current;
    if (!animate || !l || reduceMotion()) return;
    const L = l.getTotalLength();
    l.style.strokeDasharray = `${L} ${L + 4}`;
    l.animate([{ strokeDashoffset: L + 4 }, { strokeDashoffset: 0 }], { duration: 900, easing: 'cubic-bezier(.65,0,.35,1)' }).onfinish = () => {
      l.style.strokeDasharray = '';
    };
    // Only the first draw animates; later values stream in without a redraw.
  }, []);
  const first = c.series[0]?.values ?? [];
  const labelAt = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const fill = c.type === 'area' ? 'rgb(var(--ink-rgb,43 42 39) / .10)' : 'rgb(var(--ink-rgb,43 42 39) / .05)';
  return (
    <svg className="chart" width={W + 32 + 24} height={H + 46} style={{ overflow: 'visible' }}>
      <g transform="translate(8,8)">
        {ticks.map((g, i) => (
          <g key={i}>
            <line x1="0" x2={W} y1={y(g)} y2={y(g)} stroke="var(--soft)" />
            <text x={W + 8} y={y(g) + 4}>{fmt(g, c.unit)}</text>
          </g>
        ))}
        {c.series.length === 1 && first.length > 1 && <path d={`${paths[0]} L${x(first.length - 1)} ${y(lo)} L0 ${y(lo)}Z`} fill={fill} />}
        {paths.map((d, i) => (
          <path key={i} ref={i === 0 ? ref : undefined} d={d} fill="none" stroke={SERIES[i]} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {c.series.length === 1 && first.length > 0 && <circle cx={x(first.length - 1)} cy={y(first[first.length - 1])} r="3.5" fill="var(--coral)" />}
        {c.labels.length > 0 && labelAt.map((i) => (
          <text key={i} x={x(i)} y={H + 22} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{c.labels[i] ?? ''}</text>
        ))}
      </g>
    </svg>
  );
}

function Chart({ item }: { item: RichItem }) {
  const c = (item.detail as Of<'chart'>).chart;
  const [animate] = useState(!item.partial);
  // The shared column observer; only narrow windows size the drawing from it, so wide ones keep the fixed size.
  const [ref, cw] = useWidth(colOf);
  const room = cw > 0 && isNarrow() ? cw - 2 : 0;
  if (c.type === 'stat') {
    const v = c.series[0]?.values ?? [];
    const cols = Math.min(4, Math.max(1, v.length));
    return (
      <div className="frame" data-id={item.id} ref={ref}>
        {c.title ? <div className="fh"><span className="n">{c.title}</span><FxBtn label={c.title} /></div> : <FxBtn label="Numbers" float />}
        <div className={`stats s${cols}`} style={{ gridTemplateColumns: `repeat(${cols},150px)` }}>
          {v.map((x, i) => <div key={i}><b>{fmt(x, c.unit)}{c.unit && c.unit !== '%' ? <small className="u">{c.unit}</small> : null}</b><small>{c.labels[i] ?? ''}</small></div>)}
        </div>
      </div>
    );
  }
  const last = c.series[0]?.values.at(-1);
  const empty = !c.series.some((x) => x.values.length);
  return (
    <div className="frame" data-id={item.id} ref={ref}>
      <div className="fh">
        <span className="n">{c.title || 'Chart'}</span>
        <Legend c={c} />
        {c.type === 'bar' ? c.unit && <span>{c.unit}</span> : last !== undefined && c.series.length === 1 && <span className="end">{fmt(last, c.unit)}</span>}
        <FxBtn label={c.title || 'Chart'} />
      </div>
      {empty ? <div className="vmsg"><Pending text="Drawing the chart…" /></div> : c.type === 'bar' ? <BarChart c={c} room={room} /> : <LineChart c={c} animate={animate} room={room} />}
    </div>
  );
}

const NUM = /^[-+−]?[$€£]?[\d.,]+\s*[%a-zµ]*$/i;
function pill(text: string) {
  if (/^(passed|pass|ok|success)$/i.test(text)) return <span className="pill ok">{text}</span>;
  if (/^(failed|fail|error)$/i.test(text)) return <span className="pill f">{text}</span>;
  if (/^(skipped|skip|pending)$/i.test(text)) return <span className="pill sk">{text}</span>;
  return text;
}

function Table({ item }: { item: RichItem }) {
  const t: TableSpec = (item.detail as Of<'table'>).table;
  const numeric = t.columns.map((_, i) => {
    const cells = t.rows.map((r) => r[i] ?? '').filter((c) => c && c !== '—' && c !== '-');
    return cells.length > 0 && cells.every((c) => NUM.test(c.trim()));
  });
  const cls = (i: number) => (t.align[i] === 'right' || (!t.align[i] && numeric[i]) ? 'num' : t.align[i] === 'center' ? 'mid' : undefined);
  return (
    <div className="frame" data-id={item.id}>
      {t.title || t.note ? (
        <div className="fh"><span className="n">{t.title}</span>{t.note && <span className="end">{t.note}</span>}<FxBtn label={t.title || 'Table'} /></div>
      ) : (
        <FxBtn label="Table" float />
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

function Choice({ item }: { item: RichItem }) {
  const c: ChoiceSpec = (item.detail as Of<'choice'>).choice;
  const sessionId = useStore((s) => s.current);
  const [sel, setSel] = useState(0);
  const [own, setOwn] = useState('');
  const r = item.result;
  if (r) {
    const label = typeof r.choice === 'number' ? c.options[r.choice]?.label : null;
    return (
      <div className="say old" data-id={item.id}>
        {label ? <>You picked <b className="pick">{label}</b>.</> : r.answer ? <>You answered <b className="pick">{r.answer}</b></> : <>{c.question} <span className="pick-none">No answer was given.</span></>}
      </div>
    );
  }
  // The row after the options is the typed answer.
  const OWN = c.options.length;
  const submit = (i: number) => {
    if (item.partial || !sessionId) return;
    if (i === OWN) {
      if (!own.trim()) return;
      pickChoiceLocal(item.id, own.trim());
      send({ type: 'choice-answer', sessionId, id: item.id, text: own.trim() });
      return;
    }
    if (!c.options[i]) return;
    pickChoiceLocal(item.id, i);
    send({ type: 'choice-answer', sessionId, id: item.id, index: i });
  };
  const onKey = (e: KeyboardEvent) => {
    // Keeps Enter here from also answering a permission or sending the composer.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(sel);
    }
  };
  return (
    <form className="frame choice" data-id={item.id} onSubmit={(e) => (e.preventDefault(), submit(sel))} onKeyDown={onKey}>
      <div className="fh"><span className="n">{c.question}</span></div>
      {c.options.map((o, i) => (
        <label key={i} className="co" onDoubleClick={() => submit(i)}>
          <input type="radio" name={`ch-${item.id}`} value={i} checked={sel === i} onChange={() => setSel(i)} />
          <span><b>{o.label}</b>{o.description && <small>{o.description}</small>}</span>
        </label>
      ))}
      <label className="co">
        <input type="radio" name={`ch-${item.id}`} value={OWN} checked={sel === OWN} onChange={() => setSel(OWN)} />
        <input className="aqo" placeholder="Or type your own answer" value={own} onFocus={() => setSel(OWN)} onChange={(e) => (setOwn(e.target.value), setSel(OWN))} />
      </label>
      <div className="cf"><span>↑↓ to pick · double-click to choose</span><button className="go2" type="submit" disabled={item.partial || (sel === OWN && !own.trim())}>Continue<kbd>↵</kbd></button></div>
    </form>
  );
}

export function Rich({ item }: { item: RichItem }) {
  if (item.replaced) return null;
  switch (item.detail.kind) {
    case 'visual':
      return <Visual item={item} />;
    case 'replay':
      return <ReplayCard item={item} />;
    case 'chart':
      return <Chart item={item} />;
    case 'table':
      return <Table item={item} />;
    // Plans live only in the Work panel; no element, so the column gap stays even.
    case 'plan':
      return null;
    case 'choice':
      return <Choice item={item} />;
    case 'round':
      return <Round item={item} />;
  }
}
