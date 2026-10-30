import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRow, AgentState, ChangeIndexFile, PlanSpec, StepStatus } from '../../server/protocol.ts';
import { currentSummary, useStore, type CardRef } from './store.ts';
import { send } from './socket.ts';
import { useIndex } from './diffs.ts';
import { openDiff } from './Focus.tsx';
import { Check, Chev, reduceMotion, tilde } from './bits.tsx';
import { Led } from './led.tsx';
import { Flap } from './flap.tsx';
import { WatchIcon, useWatchable } from './watch/Entry.tsx';
import { setWatch } from './watch/open.ts';
import { useSide, type SideTab } from './sideState.ts';

type Owner = { id: string; chip: string; name: string };
// item and card are null for a file with no loaded card (older history, or changed before the app restarted).
type FileRow = { path: string; add: number; rm: number; owners: Owner[]; item: string | null; card: string | null; label: string };
// Pause in card updates before asking the server for net counts again.
const INDEX_MS = 600;
const NO_AGENTS: AgentRow[] = [];
const NO_OPEN: Record<string, boolean> = {};

// Short chip for an agent: "Main", "codex", its model family when known, else "agent".
function chipOf(a: AgentRow | undefined) {
  if (a?.main) return 'Main';
  if (a?.kind === 'codex') return 'codex';
  return (a && /opus|sonnet|haiku|fable/.exec(a.model)?.[0]) || 'agent';
}

// Deepest folder holding every listed file; the session cwd wins when it sits deeper.
function fileRoot(paths: string[], cwd: string) {
  const abs = paths.filter((p) => p.startsWith('/'));
  if (!abs.length) return cwd;
  let common = abs[0].slice(0, abs[0].lastIndexOf('/'));
  for (const p of abs) while (common && !p.startsWith(common + '/')) common = common.slice(0, common.lastIndexOf('/'));
  return cwd && (cwd === common || cwd.startsWith(common + '/')) ? cwd : common;
}

const rootLabel = (root: string, home: string) => {
  const t = tilde(root, home);
  const s = t.split('/');
  return s.length > 2 ? s.slice(-2).join('/') : t;
};

// Fades a region's bottom edge while it has more below.
function fitScroll(el: Element | null) {
  if (el instanceof HTMLElement) el.classList.toggle('mb', el.scrollTop + el.clientHeight < el.scrollHeight - 2);
}

type Step = { text: string; status: StepStatus };
// end: how a finished group ended; folding is always the reader's choice.
type Group = { id: string; chip: string; name: string; title: string; steps: Step[]; more: number; done: number; total: number; live: boolean; end: AgentState | null };
const isLive = (a: AgentRow) => a.state === 'running' || a.state === 'waiting';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// An agent's reported steps: the ones before the last are done, the last is current while it runs.
function logGroup(a: AgentRow): Group | null {
  const s = a.steps;
  // Rows from a server without stepLog fall back to the current step text.
  const log = a.stepLog?.length ? a.stepLog : s && a.now ? [a.now] : [];
  if (!log.length && !s) return null;
  const live = isLive(a);
  const ok = a.state === 'done';
  const total = Math.max(s?.total ?? 0, log.length);
  const steps: Step[] = log.map((text, i) => ({ text, status: i < log.length - 1 || ok ? 'done' : live ? 'doing' : 'todo' }));
  const done = Math.min(total, ok ? Math.max(s?.done ?? 0, log.length) : s?.done ?? 0);
  const name = a.main ? 'Main' : a.name;
  return { id: a.id, chip: chipOf(a), name, title: s?.task || (a.main ? 'Progress' : a.name), steps, more: live ? total - log.length : 0, done, total, live, end: live ? null : a.state };
}

// Main first (its plan, else its own progress), then subagents in the order they started.
function workGroups(plan: PlanSpec | null, agents: AgentRow[], working: boolean): Group[] {
  const out: Group[] = [];
  const main = agents.find((a) => a.main);
  if (plan) {
    const done = plan.steps.filter((s) => s.status === 'done').length;
    const end = !working && done === plan.steps.length ? 'done' : null;
    out.push({ id: 'main', chip: 'Main', name: 'Main', title: plan.title || 'Plan', steps: plan.steps, more: 0, done, total: plan.steps.length, live: working, end });
  } else if (main) {
    const g = logGroup(main);
    if (g) out.push(g);
  }
  for (const a of agents.filter((x) => !x.main).sort((x, y) => x.startedAt - y.startedAt)) {
    const g = logGroup(a);
    if (g) out.push(g);
  }
  return out;
}

// Every file changed this session, newest first; a click opens the latest card that touched it.
// Counts are the server's net per file (changes-index); summing cards would count an edit and its undo twice.
// fresh: the index answers the current cards, so a file missing from it was put back and drops out.
function changedFiles(cardsOf: Record<string, CardRef[]>, order: string[], agents: AgentRow[], index: ChangeIndexFile[] | null, fresh: boolean): FileRow[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  const chips = new Map(agents.map((a) => [a.id, chipOf(a)]));
  const refs = Object.values(cardsOf).flat().sort((a, b) => (pos.get(a[0]) ?? 0) - (pos.get(b[0]) ?? 0));
  const rows = new Map<string, FileRow>();
  for (const [item, c] of refs) {
    for (const f of c.files) {
      const r = rows.get(f.path) ?? { path: f.path, add: 0, rm: 0, owners: [], item, card: c.id, label: c.name };
      r.add += f.add;
      r.rm += f.rm;
      const chip = c.kind ?? (c.main ? 'Main' : chips.get(c.owner) ?? 'agent');
      if (!r.owners.some((o) => o.id === c.owner)) r.owners.push({ id: c.owner, chip, name: c.name });
      Object.assign(r, { item, card: c.id, label: c.name });
      rows.delete(f.path);
      rows.set(f.path, r);
    }
  }
  const newest = [...rows.values()].reverse();
  if (!index) return newest;
  const net = new Map(index.map((f) => [f.path, f]));
  const out: FileRow[] = [];
  for (const r of newest) {
    const n = net.get(r.path);
    if (n) out.push({ ...r, add: n.add, rm: n.rm });
    else if (!fresh) out.push(r);
  }
  for (const f of index) if (!rows.has(f.path)) out.push({ path: f.path, add: f.add, rm: f.rm, owners: [], item: null, card: null, label: '' });
  return out;
}

// Tasks and Files share the session indexes, but each gets its own full-height tab.
export function SessionMap({ tab, full }: { tab: SideTab; full: boolean }) {
  const sessionId = useStore((s) => s.current);
  const summary = useStore(currentSummary);
  const working = useStore((s) => s.status === 'working');
  const started = useStore((s) => s.order.length > 0);
  const watchable = useWatchable();
  const plan = useStore((s) => {
    const it = s.lastPlan ? s.items[s.lastPlan] : undefined;
    return it?.kind === 'rich' && it.detail.kind === 'plan' ? it.detail.plan : null;
  });
  const agents = useStore((s) => (s.current ? s.panels[s.current]?.agents : undefined) ?? NO_AGENTS);
  const cardsOf = useStore((s) => s.cardsOf);
  const order = useStore((s) => s.order);
  const home = useStore((s) => s.home);
  const index = useIndex((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const [asked, setAsked] = useState<{ sid: string; req: string; cards: typeof cardsOf } | null>(null);
  const fresh = !!index && asked?.sid === sessionId && asked.req === index.req && asked.cards === cardsOf;
  const files = useMemo(() => changedFiles(cardsOf, order, agents, index?.files ?? null, fresh), [cardsOf, order, agents, index, fresh]);
  const groups = useMemo(() => workGroups(plan, agents, working), [plan, agents, working]);
  // Groups and "N done" folds the reader opened or closed, per session; the rest keep their defaults.
  const [flip, setFlip] = useState<{ sid: string | null; open: Record<string, boolean> }>({ sid: null, open: NO_OPEN });
  const opened = flip.sid === sessionId ? flip.open : NO_OPEN;
  const tasksRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);

  const visible = !!sessionId && started;

  // Net counts come from the server once card updates pause.
  useEffect(() => {
    if (!sessionId || !visible) return;
    const t = setTimeout(() => {
      const req = Math.random().toString(36).slice(2, 10);
      setAsked({ sid: sessionId, req, cards: cardsOf });
      send({ type: 'changes-index', sessionId, req });
    }, INDEX_MS);
    return () => clearTimeout(t);
  }, [sessionId, cardsOf, visible]);
  const done = groups.reduce((n, g) => n + g.done, 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const add = files.reduce((n, f) => n + f.add, 0);
  const rm = files.reduce((n, f) => n + f.rm, 0);
  const fileCount = plural(files.length, 'file');
  const count = total ? `${done} of ${total}` : '';
  const tasksDone = total > 0 && done === total;
  useEffect(() => useSide.setState({ work: count, tasksDone, files: files.length }), [count, tasksDone, files.length]);
  const cwd = summary?.cwd?.replace(/\/+$/, '') ?? '';
  const root = useMemo(() => fileRoot(files.map((f) => f.path), cwd), [files, cwd]);
  const rel = (p: string) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : tilde(p, home));
  const on = tab === 'tasks';
  const toggle = (key: string, now: boolean) => setFlip({ sid: sessionId, open: { ...opened, [key]: !now } });

  // Watching the content too catches growth inside a region capped by max-height.
  useEffect(() => {
    if (tab === 'agents') return;
    const ro = new ResizeObserver((es) => es.forEach((e) => fitScroll(e.target.closest('.wk-scroll'))));
    for (const el of [tasksRef.current, filesRef.current]) {
      if (!el) continue;
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => ro.disconnect();
  }, [tab, full]);

  // A new current step scrolls into view inside the list; showing the tab jumps to the latest current step, or the newest task.
  const curKey = groups.flatMap((g) => g.steps.flatMap((s, i) => (s.status === 'doing' ? [`${g.id}:${i}`] : []))).join('|');
  const seenKey = useRef(curKey);
  const wasShown = useRef(false);
  useEffect(() => {
    const prev = seenKey.current.split('|');
    seenKey.current = curKey;
    const opening = on && !wasShown.current;
    wasShown.current = on;
    const k = !on ? undefined : opening ? curKey.split('|').filter(Boolean).pop() : curKey ? curKey.split('|').find((x) => !prev.includes(x)) : undefined;
    if (!k && !opening) return;
    const jump = () => {
      const list = tasksRef.current;
      const el = k ? list?.querySelector(`[data-k="${CSS.escape(k)}"]`) : list?.querySelector('.wk-in')?.lastElementChild;
      if (!list || !el) return;
      const l = list.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // 36px clears the sticky group header, 32px the bottom fade mask.
      const dy = r.top < l.top + 36 ? r.top - l.top - 40 : r.bottom > l.bottom - 32 ? r.bottom - l.bottom + 32 : 0;
      if (dy) list.scrollBy({ top: dy, behavior: opening || reduceMotion() ? 'auto' : 'smooth' });
    };
    const raf = requestAnimationFrame(jump);
    return () => cancelAnimationFrame(raf);
  }, [curKey, on]);

  return (
    <>
    <section className={`smap${full ? ' full' : ''}`} id="sc-tasks" role="tabpanel" aria-labelledby="sc-t-tasks" hidden={!on}>
        <div className="sm-top">
          <span className="now"><Flap text={count ? `${count} steps` : 'No tasks yet'} /></span>
          {watchable && (
            <button type="button" className="wt-open" title="Watch the session" onClick={(e) => setWatch(true, e.currentTarget)}>
              <WatchIcon /><span className="wt-l">Watch</span>
            </button>
          )}
        </div>
        <div className="sm-body"><div>
        <div className="wk-body">
            <div ref={tasksRef} className="wk-scroll wk-tasks" onScroll={(e) => fitScroll(e.currentTarget)}>
              <div className="wk-in">
                {groups.length
                  ? groups.map((g) => <WorkGroup key={g.id} g={g} open={opened[g.id] ?? true} oldOpen={opened[`${g.id}:old`] ?? true} toggle={toggle} />)
                  : <p className="wk-empty">No task list. One shows up on longer jobs.</p>}
              </div>
            </div>
        </div>
        </div></div>
    </section>
    <section className={`smap${full ? ' full' : ''}`} id="sc-files" role="tabpanel" aria-labelledby="sc-t-files" hidden={tab !== 'files'}>
        <div className="sm-top">
          <span className="now" title={tilde(root, home)}>{root ? rootLabel(root, home) : 'Changed this session'}</span>
          <span className="wk-tot">{fileCount} <span className="add">+{add}</span> <span className="del">−{rm}</span></span>
        </div>
        <div className="sm-body"><div>
        <div className="wk-body">
            <div className="wk-freg">
              <div ref={filesRef} className="wk-scroll" onScroll={(e) => fitScroll(e.currentTarget)}>
                <div className="wk-in">
                  {files.length ? (
                    <div className="wk-files">
                      {files.map((f) => {
                        const p = rel(f.path);
                        const cut = p.lastIndexOf('/') + 1;
                        const last = f.owners[f.owners.length - 1];
                        const { item, card } = f;
                        return (
                          <button
                            key={f.path} type="button" className="wk-f" disabled={!item || !card}
                            title={item ? `${tilde(f.path, home)} · open the diff` : `${tilde(f.path, home)} · no change card for it is loaded here, so there is no diff to open`}
                            onClick={(e) => sessionId && item && card && openDiff({ sessionId, item, card }, f.label, e.currentTarget)}
                          >
                            <span className="wk-p">{cut > 0 && <span className="wk-dir">{p.slice(0, cut)}</span>}<b>{p.slice(cut)}</b></span>
                            {last ? <span className="wk-own" title={f.owners.map((o) => o.name).join(', ')}>{last.chip}{f.owners.length > 1 && ` +${f.owners.length - 1}`}</span> : <span></span>}
                            <span className="wk-n"><span className="add">+{f.add}</span> <span className="del">−{f.rm}</span></span>
                          </button>
                        );
                      })}
                    </div>
                  ) : <p className="wk-empty">Nothing changed yet.</p>}
                </div>
              </div>
            </div>
        </div>
        </div></div>
    </section>
    </>
  );
}

const END_LABEL: Partial<Record<AgentState, string>> = { done: 'Done', failed: 'Failed', stopped: 'Stopped' };

function EndMark({ end }: { end: AgentState }) {
  return (
    <i className={`wk-end ${end}`} role="img" title={END_LABEL[end]} aria-label={END_LABEL[end]}>
      {end === 'done' ? <Check /> : end === 'failed' ? '✕' : '–'}
    </i>
  );
}

// One agent's checklist. Folded content stays mounted when the reader hides it.
function WorkGroup({ g, open, oldOpen, toggle }: { g: Group; open: boolean; oldOpen: boolean; toggle: (key: string, now: boolean) => void }) {
  const at = g.live && g.done < g.total ? Math.min(g.done + 1, g.total) : g.done;
  const lead = g.steps.findIndex((s) => s.status !== 'done');
  const doneLead = lead < 0 ? g.steps.length : lead;
  // Older completed steps can fold together, but stay visible until the reader closes them.
  const fold = g.live && doneLead >= 4 ? doneLead - 2 : 0;
  const row = (st: Step, i: number) => (
    <li key={i} data-k={`${g.id}:${i}`} className={st.status}>
      <i>{st.status === 'doing' && g.live ? <Led size="sm" pattern="calm" /> : <Check />}</i>
      <span>{st.text}</span>
    </li>
  );
  return (
    <div className={`wk-g${g.end ? ' fin' : ''}${g.live ? ' live' : ''}${open ? '' : ' shut'}`}>
      <button type="button" className="wk-gh" aria-expanded={open} title={`${open ? 'Collapse' : 'Expand'} ${g.title}`} onClick={() => toggle(g.id, open)}>
        {g.end ? <EndMark end={g.end} /> : <i className={`wk-end${g.live ? ' live' : ''}`} aria-hidden="true"></i>}
        <b title={g.title}>{g.title}</b>
        <span className="wk-chip" title={g.name}>{g.chip}</span>
        <span className="wk-gc">{g.end && !open ? plural(g.total, 'step') : `${at} of ${g.total}`}</span>
        <span className="wk-disclosure" aria-hidden="true"><Chev /></span>
      </button>
      <div className="wk-fold" inert={!open}>
        <ol className="wk-steps">
          {fold > 0 && (
            <li key="old" className="wk-old">
              <button type="button" aria-expanded={oldOpen} title={`${oldOpen ? 'Collapse' : 'Expand'} completed steps`} onClick={() => toggle(`${g.id}:old`, oldOpen)}>
                <span className="wk-disclosure" aria-hidden="true"><Chev /></span>
                <span>{fold} done</span>
                <span className="wk-toggle">{oldOpen ? 'Collapse' : 'Expand'}</span>
              </button>
              <div className="wk-fold" inert={!oldOpen}>
                <ol className="wk-steps">{g.steps.slice(0, fold).map(row)}</ol>
              </div>
            </li>
          )}
          {g.steps.slice(fold).map((st, j) => row(st, fold + j))}
        </ol>
        {g.more > 0 && <p className="wk-more">{plural(g.more, 'more step')}</p>}
      </div>
    </div>
  );
}
