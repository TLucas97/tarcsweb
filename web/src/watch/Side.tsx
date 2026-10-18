import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useEscape } from '../bits.tsx';
import { upTo, type Action, type FileTouchAt, type WatchModel } from './model.ts';
import type { Lane } from './lanes.ts';
import { legAt } from './director.ts';
import { checkName, clockOf, dur } from './world.ts';

// Watch mode's side panel: one agent's actions and narration up to the playhead, or every agent's files. Plain DOM
// over the stage; the stage calls `side` each frame it draws, and the panel renders only when what shows at T changed.

export type Pan = { k: 'agent'; aid: string } | { k: 'files' };
export type SideHost = {
  m: WatchModel; readonly T: number; readonly atLive: boolean;
  side: ((T: number) => void) | null;
  seekTo(t: number): void; setPan(p: Pan | null): void;
};

// Items rendered before "Show earlier", and how many each press adds; a live burst larger than FRESH lands without the fade.
const LIMIT = 300;
const FRESH = 4;

type Item = { k: 'say'; id: string; t: number; s: string } | { k: 'act'; id: string; t: number; a: Action };
type State = 'running' | 'done' | 'failed' | 'stopped' | 'working' | 'idle' | 'later';
type Res = 'run' | 'ok' | 'fail' | '';
type Group = { id: string; name: string; files: FileTouchAt[] };
const WORD: Record<State, string> = { running: 'running', done: 'returned', failed: 'failed', stopped: 'stopped', working: 'working', idle: 'idle', later: 'not started' };

const panKey = (p: Pan) => (p.k === 'files' ? 'files' : p.aid);
const laneOf = (m: WatchModel, aid: string) => (aid === 'main' ? undefined : m.agents.find((l) => l.row.aid === aid));
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;
const dirName = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
const isRun = (v: string) => v === 'run' || v === 'background';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function nameOf(m: WatchModel, aid: string, lane: Lane | undefined) {
  return aid === 'main' ? 'Main agent' : m.panelAgent(aid)?.name || lane?.row.label || 'Agent';
}

// Where an agent stands at view time T, and the wall span its elapsed time covers (w0 NaN: none to show).
function stateOf(m: WatchModel, aid: string, lane: Lane | undefined, T: number): { s: State; w0: number; w1: number | null } {
  if (aid === 'main') {
    if (!m.workingAt(T)) return { s: 'idle', w0: NaN, w1: null };
    const st = m.stations;
    // The turn so far: since the prompt it is working on.
    for (let i = Math.min(m.routeLen - 1, legAt(m, T) + 1); i >= 0; i--) if (st[i].kind === 'ask' && st[i].t0 <= T) return { s: 'working', w0: m.wallOf(st[i].t0), w1: null };
    return { s: 'working', w0: NaN, w1: null };
  }
  if (!lane) return { s: 'done', w0: NaN, w1: null };
  const r = lane.row;
  if (r.t > T) return { s: 'later', w0: NaN, w1: null };
  const e = m.agentEnd(r);
  if (e.end === null || T < e.end) return { s: 'running', w0: r.w0, w1: null };
  return { s: e.fin === 'running' || e.fin === 'waiting' ? 'done' : e.fin, w0: r.w0, w1: m.wallOf(e.end) };
}

function elapsed(m: WatchModel, st: ReturnType<typeof stateOf>, T: number) {
  return Number.isNaN(st.w0) || m.source !== 'timeline' ? '' : dur(Math.max(0, (st.w1 ?? m.wallOf(T)) - st.w0));
}

// What the panel shows at T, as a string: it changes when an action or line appears, settles or the agent ends.
function keyOf(m: WatchModel, pan: Pan, lane: Lane | undefined, T: number) {
  if (pan.k === 'files') {
    let s = 0;
    for (const L of m.logs.values()) s += upTo(L.acts, T);
    return `${m.version}|${s}`;
  }
  const L = m.agentLog(pan.aid), j = L ? upTo(L.acts, T) : 0;
  let done = 0;
  for (let i = Math.max(0, j - 40); L && i < j; i++) if (L.acts[i].res !== null && L.acts[i].res! <= T) done++;
  return `${m.version}|${j}|${L ? upTo(L.says, T) : 0}|${done}|${stateOf(m, pan.aid, lane, T).s}`;
}

// The newest `limit` actions and narration lines by T, oldest first; narration goes before the action it led to.
function itemsOf(m: WatchModel, aid: string, T: number, limit: number) {
  const L = m.agentLog(aid);
  if (!L) return { list: [] as Item[], earlier: 0, gone: 0 };
  let i = upTo(L.acts, T), j = upTo(L.says, T);
  const out: Item[] = [];
  while ((i || j) && out.length < limit) {
    if (j && (!i || L.says[j - 1].t > L.acts[i - 1].t)) {
      const s = L.says[--j];
      out.push({ k: 'say', id: `s${s.w}|${s.t}`, t: s.t, s: s.s });
    } else {
      const a = L.acts[--i];
      out.push({ k: 'act', id: a.id, t: a.t, a });
    }
  }
  return { list: out.reverse(), earlier: i + j, gone: L.more };
}

const resOf = (a: Action, T: number): Res =>
  a.res !== null && a.res <= T ? (a.err ? 'fail' : 'ok') : isRun(a.verb) || a.verb === 'agent' ? 'run' : '';

const kindOf = (a: Action) =>
  a.verb === 'read' ? 'read'
  : a.verb === 'edit' || a.verb === 'write' ? (a.created ? 'new' : 'edit')
  : a.verb === 'search' || a.verb === 'web' ? 'search'
  : isRun(a.verb) ? 'run'
  : a.verb === 'agent' ? 'agent'
  : 'other';

export default function Side({ host, pan, open }: { host: SideHost; pan: Pan; open: boolean }) {
  useEscape(open, () => host.setPan(null));
  return (
    <aside className="wt-pan" data-open={open ? '' : undefined} inert={!open} aria-label={pan.k === 'files' ? 'Files by agent' : 'Agent actions'}>
      <Body key={panKey(pan)} host={host} pan={pan} open={open} />
    </aside>
  );
}

function Body({ host, pan, open }: { host: SideHost; pan: Pan; open: boolean }) {
  const m = host.m;
  const [view, setView] = useState(() => ({ T: host.T, prev: Infinity }));
  const [tab, setTab] = useState<'acts' | 'files'>('acts');
  const [limit, setLimit] = useState(LIMIT);
  const [away, setAway] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const acts = useRef<HTMLElement>(null);
  const filesEl = useRef<HTMLElement>(null);
  const took = useRef<HTMLSpanElement>(null);
  const stick = useRef(true);

  // Each frame the stage draws: render when the visible state changed; the elapsed time is written in place.
  useEffect(() => {
    if (!open) return;
    let ver = m.version, lane = pan.k === 'agent' ? laneOf(m, pan.aid) : undefined, lastT = host.T, tk = '';
    let last = keyOf(m, pan, lane, lastT);
    const frame = (T: number) => {
      if (m.version !== ver) (ver = m.version), (lane = pan.k === 'agent' ? laneOf(m, pan.aid) : undefined);
      const k = keyOf(m, pan, lane, T);
      if (k !== last) {
        last = k;
        setView({ T, prev: host.atLive ? lastT : Infinity });
        lastT = T;
      }
      if (pan.k === 'agent' && took.current) {
        const s = elapsed(m, stateOf(m, pan.aid, lane, T), T);
        if (s !== tk) (tk = s), (took.current.textContent = s);
      }
    };
    host.side = frame;
    setView({ T: host.T, prev: Infinity });
    frame(host.T);
    return () => {
      if (host.side === frame) host.side = null;
    };
  }, [host, m, pan, open]);

  // Live, the list keeps its newest line in view unless the owner scrolled up.
  useEffect(() => {
    const el = acts.current;
    if (!el || !stick.current || tab !== 'acts') return;
    const id = requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    return () => cancelAnimationFrame(id);
  }, [view, tab, limit]);

  // React writes `hidden` as a boolean, so the closed tab gets "until-found" here: find-in-page still reaches it.
  useLayoutEffect(() => {
    const pairs: [HTMLElement | null, string][] = [[acts.current, 'acts'], [filesEl.current, 'files']];
    for (const [el, k] of pairs) {
      if (!el) continue;
      if (k === tab || pan.k === 'files') el.removeAttribute('hidden');
      else el.setAttribute('hidden', 'until-found');
    }
  }, [tab, pan.k]);

  // The browser opens a matched tab itself; follow it.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = (e: Event) => {
      const k = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
      if (k === 'acts' || k === 'files') setTab(k);
    };
    el.addEventListener('beforematch', on);
    return () => el.removeEventListener('beforematch', on);
  }, []);

  const seek = (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
    if (b) host.seekTo(Number(b.dataset.t));
  };
  const onScroll = () => {
    const el = acts.current;
    if (!el) return;
    const at = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    stick.current = at;
    setAway(!at);
  };
  const jump = () => {
    const el = acts.current;
    if (!el) return;
    stick.current = true;
    setAway(false);
    el.scrollTop = el.scrollHeight;
  };
  const close = () => host.setPan(null);

  const T = view.T;
  if (pan.k === 'files') {
    const groups: Group[] = [{ id: 'main', name: nameOf(m, 'main', undefined), files: m.filesAt('main', T) }];
    for (const l of m.agents) {
      if (l.row.t > T || !l.row.aid) continue;
      const f = m.filesAt(l.row.aid, T);
      if (f.length) groups.push({ id: l.row.aid, name: nameOf(m, l.row.aid, l), files: f });
    }
    const n = groups.filter((g) => g.files.length).length;
    return (
      <div className="pan-in" ref={root}>
        <header className="pan-h">
          <div className="pan-t">
            <b>Files</b>
            <Close onClick={close} />
          </div>
          <div className="pan-sub">{n > 1 ? `${n} agents touched files, up to the playhead` : 'Up to the playhead'}</div>
        </header>
        <div className="pan-body">
          <section ref={filesEl} data-tab="files" className="pan-sc" onClick={seek}>
            <FilesView groups={groups} single={false} />
          </section>
        </div>
      </div>
    );
  }

  const aid = pan.aid, lane = laneOf(m, aid), st = stateOf(m, aid, lane, T);
  const { list, earlier, gone } = itemsOf(m, aid, T, limit);
  const files = m.filesAt(aid, T);
  const count = m.actionAt(aid, T).count;
  const model = m.panelAgent(aid)?.model;
  const times = m.source === 'timeline';
  let cur: Action | null = null;
  for (let i = list.length - 1; i >= 0 && !cur; i--) if (list[i].k === 'act') cur = (list[i] as Extract<Item, { k: 'act' }>).a;
  let nFresh = 0;
  for (let i = list.length - 1; i >= 0 && list[i].t > view.prev; i--) nFresh++;
  const fresh = (t: number) => nFresh <= FRESH && t > view.prev;
  const name = nameOf(m, aid, lane);
  return (
    <div className="pan-in" ref={root}>
      <header className="pan-h">
        <div className="pan-t">
          <b title={name}>{name}</b>
          <span className="pan-s" data-s={st.s}>{WORD[st.s]}</span>
          <Close onClick={close} />
        </div>
        <div className="pan-sub mono">
          {[model, plural(count, 'action')].filter(Boolean).join(' · ')}
          <span className="pan-took" ref={took} />
        </div>
      </header>
      <div className="pan-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'acts'} onClick={() => setTab('acts')}>Actions</button>
        <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
          Files<span className="mono">{files.length}</span>
        </button>
      </div>
      <div className="pan-body">
        <section ref={acts} data-tab="acts" role="tabpanel" aria-label="Actions" className="pan-sc" onScroll={onScroll} onClick={seek}>
          {earlier > 0 ? (
            <button type="button" className="pan-more" onClick={() => setLimit((l) => l + LIMIT)}>Show {Math.min(LIMIT, earlier)} earlier</button>
          ) : gone > 0 ? (
            <p className="pan-note">{plural(gone, 'earlier action')} not kept</p>
          ) : null}
          {!list.length && (
            <p className="pan-empty">{st.s === 'later' ? 'Not started yet at this point.' : st.s === 'running' || st.s === 'working' ? 'Starting…' : 'No actions here.'}</p>
          )}
          <ol className="pan-list">
            {list.map((it) =>
              it.k === 'say' ? (
                <SayRow key={it.id} t={it.t} s={it.s} fresh={fresh(it.t)} />
              ) : (
                <ActRow key={it.id} a={it.a} res={resOf(it.a, T)} cur={it.a === cur} fresh={fresh(it.t)} when={times ? clockOf(it.a.w0) : ''} />
              ),
            )}
          </ol>
        </section>
        <section ref={filesEl} data-tab="files" role="tabpanel" aria-label="Files" className="pan-sc" onClick={seek}>
          <FilesView groups={[{ id: aid, name, files }]} single />
        </section>
      </div>
      {away && tab === 'acts' && (
        <button type="button" className="wt-btn pan-jump" onClick={jump}>Jump to now</button>
      )}
    </div>
  );
}

const Close = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="wt-btn pan-x" title="Close (esc)" aria-label="Close" onClick={onClick}>
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" /></svg>
  </button>
);

const SayRow = memo(function SayRow({ t, s, fresh }: { t: number; s: string; fresh: boolean }) {
  return (
    <li className="ps" data-new={fresh ? '' : undefined}>
      <button type="button" className="pa" data-t={t}><span className="ps-s">{s}</span></button>
    </li>
  );
});

const ActRow = memo(function ActRow({ a, res, cur, fresh, when }: { a: Action; res: Res; cur: boolean; fresh: boolean; when: string }) {
  const k = kindOf(a), file = !!a.path;
  const name = file ? baseName(a.path) : a.verb === 'agent' ? `Agent: ${a.label}` : a.verb === 'search' ? `Search ${a.label}` : a.label;
  const tags: [string, string][] = [];
  const state = res === 'ok' ? 'ok' : res === 'fail' ? 'failed' : 'running';
  const tone = res === 'ok' ? 'g' : res === 'fail' ? 'r' : 'a';
  if (a.check) tags.push([`${checkName(a.check, a.cmd || a.label)} ${state}`, tone]);
  else if (isRun(a.verb)) tags.push([state, tone]);
  else if (k === 'edit' || k === 'new') {
    tags.push([`+${a.add}`, 'g'], [`−${a.rm}`, 'r']);
    if (a.created) tags.push(['new', 'a']);
  } else if (k === 'read') tags.push(['read', '']);
  if (res === 'fail' && !a.check && !isRun(a.verb)) tags.push(['failed', 'r']);
  return (
    <li data-k={k} data-s={res || undefined} data-cur={cur ? '' : undefined} data-new={fresh ? '' : undefined}>
      <button type="button" className="pa" data-t={a.t} title={[when, a.path || a.cmd || a.label].filter(Boolean).join(' · ')}>
        <i className="ov-ic" aria-hidden="true" />
        <span className="pa-l">
          <span className="pa-n">{name}</span>
          {file && <span className="pa-d mono">{dirName(a.path)}</span>}
        </span>
        {tags.length > 0 && <span className="pa-m mono">{tags.map(([t, c]) => <span key={t} className={c}>{t}</span>)}</span>}
        {a.cmd && a.cmd !== a.label && <span className="pa-c mono">$ {a.cmd}</span>}
        {res === 'fail' && a.why && <span className="pa-why mono">{a.why}</span>}
      </button>
    </li>
  );
});

function FilesView({ groups, single }: { groups: Group[]; single: boolean }) {
  const paths = new Set<string>(), edited = new Set<string>();
  let add = 0, rm = 0;
  for (const g of groups) {
    for (const f of g.files) {
      paths.add(f.path);
      if (f.mode === 'edited') (edited.add(f.path), (add += f.add), (rm += f.rm));
    }
  }
  if (!paths.size) return <p className="pan-empty">No files touched yet.</p>;
  return (
    <>
      <p className="pf-tot mono">
        {plural(paths.size, 'file')} · {edited.size} edited · <span className="g">+{add}</span> <span className="r">−{rm}</span>
      </p>
      {groups.map((g) =>
        g.files.length ? (
          <div key={g.id} className="pf-g">
            {!single && <h3>{g.name}<span className="mono">{g.files.length}</span></h3>}
            <ul className="pan-list">
              {g.files.map((f) => (
                <li key={f.path} data-k={f.mode === 'read' ? 'read' : f.created ? 'new' : 'edit'}>
                  <button type="button" className="pa" data-t={f.t1} title={f.path}>
                    <i className="ov-ic" aria-hidden="true" />
                    <span className="pa-l">
                      <span className="pa-n">{baseName(f.path)}</span>
                      <span className="pa-d mono">{dirName(f.path)}</span>
                    </span>
                    <span className="pa-m mono">
                      {f.mode === 'read' ? <span>read</span> : <><span className="g">+{f.add}</span><span className="r">−{f.rm}</span>{f.created && <span className="a">new</span>}</>}
                      {f.n > 1 && <span>×{f.n}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </>
  );
}
