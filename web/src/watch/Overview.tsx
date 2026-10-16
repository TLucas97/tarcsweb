import { useEffect, useReducer, useRef, type CSSProperties } from 'react';
import { useEscape } from '../bits.tsx';
import type { Row, Station, WatchModel } from './model.ts';
import { legAt } from './director.ts';
import { World, clockOf, dur, visibleRows } from './world.ts';

// Watch mode's Overview: the turn at view time as one column per step, with the large sculpture he built there,
// how long it took and what it touched. Plain DOM over the sleeping stage; only the sculptures are canvases.

export type OverviewHost = { m: WatchModel; w: World; overviewT(): number; onModel: (() => void) | null };

const C = 20;
const GAP = Math.round(C * 0.28);
const ART_W = 5 * (C + GAP) + 46;
const ROWS_SHOWN = 8;
const PHASE: Record<string, string> = { explore: 'EXPLORE', build: 'BUILD', check: 'CHECK' };
const pad2 = (i: number) => String(i).padStart(2, '0');

type Tone = 'run' | 'ok' | 'bad' | 'mute';
type Card = { key: string; kind: 'agent' | 'needs'; title: string; tag: string; tone: Tone; line: string };
type Col = {
  st: Station; tag: string; status: 'done' | 'doing' | 'todo'; title: string; took: string; when: string; frac: number;
  rows: Row[]; earlier: number; cards: Card[]; n: number; cur: boolean;
};
type Sum = { title: string; stats: string; cols: Col[]; artH: number; end: string; endTone: Tone };

// The stations of the turn around T: after the prompt at or before it, up to the next prompt.
function turnOf(m: WatchModel, T: number) {
  const st = m.stations, k = Math.max(0, legAt(m, T));
  let a = 0;
  for (let i = Math.min(k, st.length - 1); i >= 1; i--) if (st[i].kind === 'ask') (a = i), (i = 0);
  const out: { st: Station; i: number }[] = [];
  for (let i = a + 1; i < st.length && st[i].kind !== 'ask'; i++) if (st[i].kind === 'step' || st[i].kind === 'phase') out.push({ st: st[i], i });
  return { ask: a > 0 ? st[a] : null, list: out, cur: k };
}

// When a station's work ended: marked done, or else when he walked on to the next one.
function doneAt(m: WatchModel, i: number) {
  const st = m.stations[i];
  if (!Number.isNaN(st.done)) return st.done;
  return i + 1 < m.routeLen ? m.stations[i + 1].dep : NaN;
}

function summarize(m: WatchModel, w: World, T: number, _ver: number): Sum {
  const { ask, list, cur } = turnOf(m, T);
  const wall = (t: number) => m.wallOf(t);
  const ends = list.map(({ i }) => doneAt(m, i));
  const durs = list.map(({ st, i }, j) => (i < m.routeLen && T >= st.arr && !st.past ? wall(T >= ends[j] ? ends[j] : T) - wall(st.arr) : 0));
  const maxD = Math.max(1, ...durs);
  const paths = new Set<string>();
  let add = 0, rm = 0, agents = 0, failed = 0, fixed = 0, rowsMax = 1;
  const cols = list.map(({ st, i }, j): Col => {
    const end = ends[j], here = i < m.routeLen && T >= st.arr, done = here && T >= end;
    const n = here ? visibleRows(st, T) : 0;
    rowsMax = Math.max(rowsMax, Math.min(9, n));
    const rows: Row[] = [];
    const cards: Card[] = [];
    let needs: Row | null = null;
    for (let k = 0; k < n; k++) {
      const r = st.rows[k];
      if (r.kind === 'file') {
        paths.add(r.label);
        if (r.mode === 'edited') (add += r.add), (rm += r.rm);
      }
      if (r.kind === 'fault' && r.res !== null && T >= r.res) fixed++;
      if (r.kind === 'needs') needs = r;
      else if (r.kind === 'agent') {
        const e = w.agentFacts(m, r, T), s = e.state;
        agents++;
        if (s === 'failed') failed++;
        cards.push({
          key: r.key, kind: 'agent', title: e.p?.name || r.label,
          tag: s === 'running' ? 'running' : s === 'done' ? 'returned' : s, tone: s === 'running' ? 'run' : s === 'done' ? 'ok' : s === 'failed' ? 'bad' : 'mute',
          line: s === 'running' ? (e.fin === 'running' ? e.p?.now ?? '' : '') : e.p?.said ?? '',
        });
      } else rows.push(r);
    }
    if (needs) {
      const open = needs.res === null || T < needs.res;
      cards.push({ key: needs.key, kind: 'needs', title: needs.label, tag: open ? 'Needs you' : needs.ans || 'Answered', tone: open ? 'run' : needs.err ? 'mute' : 'ok', line: '' });
    }
    const earlier = Math.max(0, rows.length - ROWS_SHOWN) + (n === st.rows.length ? st.more : 0);
    const shown = !here || st.past ? '' : dur(durs[j]);
    const when = !here || st.past ? '' : done ? `${clockOf(wall(st.arr))} → ${clockOf(wall(end))}` : `since ${clockOf(wall(st.arr))}`;
    return {
      st, n, rows: rows.slice(-ROWS_SHOWN), earlier, cards, took: shown, when, frac: durs[j] / maxD, cur: i === cur,
      tag: st.kind === 'step' ? pad2(st.num + 1) : PHASE[st.phase ?? ''] ?? 'WORK',
      status: done ? 'done' : here ? 'doing' : 'todo', title: st.label || 'Working',
    };
  });
  const allDone = !!list.length && cols.every((c) => c.status === 'done');
  const t0 = ask ? ask.t0 : list[0]?.st.arr ?? T;
  const t1 = allDone ? ends[ends.length - 1] : T;
  const past = !!list[0]?.st.past;
  // Titled by the plan he is on at T, else by the prompt that started the turn.
  const plan = m.stations[cur]?.plan ?? (list.length && list.every((x) => x.st.plan === list[0].st.plan) ? list[0].st.plan : null);
  const parts = [`${cols.length} ${cols.length === 1 ? 'step' : 'steps'}`];
  if (!past) parts.push(dur(Math.max(0, wall(t1) - wall(t0))));
  parts.push(`${paths.size} ${paths.size === 1 ? 'file' : 'files'}, +${add} −${rm}`);
  if (agents) parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}${failed ? ` (${failed} failed)` : ''}`);
  if (fixed) parts.push(`${fixed} ${fixed === 1 ? 'error' : 'errors'} recovered`);
  return {
    title: plan?.title || ask?.label || 'This session', stats: parts.join(' · '), cols,
    artH: rowsMax * (C + GAP) + 40, end: allDone ? 'DONE' : m.workingAt(T) ? 'WORKING' : 'IDLE', endTone: allDone ? 'ok' : 'mute',
  };
}

export default function Overview({ host, onClose }: { host: OverviewHost; onClose: () => void }) {
  const [ver, bump] = useReducer((x: number) => x + 1, 0);
  const grid = useRef<HTMLDivElement>(null);
  useEscape(true, onClose);

  // The session keeps moving while the Overview is open: refresh at most twice a second.
  useEffect(() => {
    let t = 0;
    host.onModel = () => {
      if (!t) t = window.setTimeout(() => ((t = 0), bump()), 500);
    };
    return () => {
      host.onModel = null;
      clearTimeout(t);
    };
  }, [host]);

  const T = host.overviewT();
  const sum = summarize(host.m, host.w, T, ver);

  // A long turn opens on the step he was at; positions are read in the observer, once, and only this pane scrolls.
  useEffect(() => {
    const g = grid.current, pane = g?.parentElement;
    if (!g || !pane) return;
    const ro = new ResizeObserver(() => {
      ro.disconnect();
      const c = g.querySelector<HTMLElement>('[data-cur]');
      if (c) pane.scrollLeft = Math.max(0, c.offsetLeft + c.offsetWidth + 24 - pane.clientWidth);
    });
    ro.observe(g);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cvs = grid.current?.querySelectorAll<HTMLCanvasElement>('canvas.ov-art') ?? [];
    cvs.forEach((cv, i) => {
      const col = sum.cols[i];
      if (!col) return;
      cv.width = Math.round(ART_W * dpr);
      cv.height = Math.round(sum.artH * dpr);
      const g = cv.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, ART_W, sum.artH);
      if (col.status !== 'todo') host.w.sculpture(g, host.m, col.st, T, C, ART_W / 2, sum.artH);
    });
  }, [sum, host, T]);

  return (
    <section className="wt-ov" aria-label="Overview">
      <header className="ov-head">
        <h2>{sum.title}</h2>
        <span className="mono">{sum.stats}</span>
      </header>
      <div className="ov-grid" ref={grid} style={{ '--art-h': `${sum.artH}px`, '--art-w': `${ART_W}px`, '--n': sum.cols.length } as CSSProperties}>
        {sum.cols.map((c) => (
          <article key={c.st.id} className="ov-col" data-s={c.status} data-cur={c.cur ? '' : undefined}>
            <div className="ov-meta mono">
              <b>{c.tag}</b>
              <span>{c.status === 'done' ? '✓' : c.status === 'doing' ? '● now' : 'next'}</span>
              {c.took && <span className="ov-took">{c.took}</span>}
              <i className="ov-bar" aria-hidden="true"><i style={{ transform: `scaleX(${c.frac.toFixed(3)})` }} /></i>
              {c.when && <span className="ov-when">{c.when}</span>}
            </div>
            <h3 className="ov-title">{c.title}</h3>
            <canvas className="ov-art" aria-hidden="true" />
            <div className="ov-floor" aria-hidden="true"><span className="mono">{c.tag}</span></div>
            <div className="ov-list">
              {c.earlier > 0 && <p className="ov-more mono">+{c.earlier} earlier</p>}
              <ul>
                {c.rows.map((r) => <RowLine key={r.key} r={r} T={T} />)}
              </ul>
              {c.cards.map((k) => (
                <div key={k.key} className="ov-card" data-k={k.kind} data-t={k.tone}>
                  {k.kind === 'agent' && <Face tone={k.tone} />}
                  <div className="ov-card-b">
                    <div className="ov-card-h">
                      <b>{k.kind === 'agent' ? k.title : k.tag}</b>
                      {k.kind === 'agent' && <span className="mono">{k.tag}</span>}
                    </div>
                    {(k.kind === 'needs' ? k.title : k.line) && <p className={k.kind === 'agent' ? 'mono' : ''}>{k.kind === 'needs' ? k.title : k.line}</p>}
                  </div>
                </div>
              ))}
            </div>
          </article>
        ))}
        <div className="ov-col ov-end" data-t={sum.endTone}>
          <div className="ov-meta mono"><b>{sum.end}</b></div>
          <i />
          <i />
          <div className="ov-floor" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}

function RowLine({ r, T }: { r: Row; T: number }) {
  let name = r.label, meta: [string, string][] = [];
  if (r.kind === 'file') {
    name = r.label.slice(r.label.lastIndexOf('/') + 1) || r.label;
    meta = r.mode === 'read' ? [['read', '']] : [[`+${r.add}`, 'g'], [`−${r.rm}`, 'r'], ...(r.created ? [['new', 'a'] as [string, string]] : [])];
  } else if (r.kind === 'run') meta = r.res !== null && T >= r.res ? [[r.err ? 'failed' : 'ok', r.err ? 'r' : 'g']] : [['running', 'a']];
  else if (r.kind === 'search') meta = [['search', '']];
  else if (r.kind === 'fault') meta = r.res !== null && T >= r.res ? [['recovered', 'g']] : [['error', 'r']];
  const fixed = r.kind === 'fault' && r.res !== null && T >= r.res;
  return (
    <li data-k={r.kind === 'file' ? (r.mode === 'read' ? 'read' : r.created ? 'new' : 'edit') : r.kind} title={r.label}>
      <i className="ov-ic" aria-hidden="true" />
      <span className={`mono ov-name${fixed ? ' ov-struck' : ''}`}>{name}</span>
      <span className="mono ov-row-meta">{meta.map(([t, c]) => <span key={t} className={c}>{t} </span>)}</span>
    </li>
  );
}

// An agent's face as it ends: the check once it returned, the X if it failed, one dot while it runs.
const LIT: Record<Tone, number[]> = { run: [3, 4, 5], ok: [3, 7, 5, 2], bad: [0, 2, 4, 6, 8], mute: [4] };
function Face({ tone }: { tone: Tone }) {
  return (
    <span className="ov-face" data-t={tone} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => <i key={i} className={LIT[tone].includes(i) ? 'on' : ''} />)}
    </span>
  );
}
