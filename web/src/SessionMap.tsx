import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLayoutVars } from './layoutVars.ts';
import { flushSync } from 'react-dom';
import type { AgentRow, AgentState, PlanSpec, StepStatus } from '../../server/protocol.ts';
import { currentSummary, useStore, type CardRef } from './store.ts';
import { openDiff } from './Focus.tsx';
import { Check, ExpandIcon, FOSI, SPRING, WorkIcon, morphBox, pref, reduceMotion, tilde, useEscape } from './bits.tsx';
import { Led } from './led.tsx';
import { Flap } from './flap.tsx';
import { WatchIcon } from './watch/Entry.tsx';
import { setWatch } from './watch/open.ts';

type Owner = { id: string; chip: string; name: string };
type FileRow = { path: string; add: number; rm: number; owners: Owner[]; item: string; card: string; label: string };
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

type View = 'tasks' | 'files' | 'both';
const VIEWS: [View, string][] = [['tasks', 'Tasks'], ['files', 'Files'], ['both', 'Both']];
const savedView = (): View => {
  const v = pref.get<string>('work.view', 'both');
  return VIEWS.some(([x]) => x === v) ? (v as View) : 'both';
};

type Step = { text: string; status: StepStatus };
// end: how a finished group ended; finished groups fold into one line.
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
function changedFiles(cardsOf: Record<string, CardRef[]>, order: string[], agents: AgentRow[]): FileRow[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  const chips = new Map(agents.map((a) => [a.id, chipOf(a)]));
  const refs = Object.values(cardsOf).flat().sort((a, b) => (pos.get(a[0]) ?? 0) - (pos.get(b[0]) ?? 0));
  const rows = new Map<string, FileRow>();
  for (const [item, c] of refs) {
    for (const f of c.files) {
      const r = rows.get(f.path) ?? { path: f.path, add: 0, rm: 0, owners: [], item, card: c.id, label: c.name };
      r.add += f.add;
      r.rm += f.rm;
      if (!r.owners.some((o) => o.id === c.owner)) r.owners.push({ id: c.owner, chip: c.main ? 'Main' : chips.get(c.owner) ?? 'agent', name: c.name });
      Object.assign(r, { item, card: c.id, label: c.name });
      rows.delete(f.path);
      rows.set(f.path, r);
    }
  }
  return [...rows.values()].reverse();
}

// The open sheet sits under the Agents panel, so it needs that panel's bottom edge; full screen is a cover, not a neighbour.
function tuck(sheet: HTMLElement | null, panel: Element | null) {
  if (sheet && panel && !panel.classList.contains('full')) sheet.style.setProperty('--at', `${Math.round(panel.getBoundingClientRect().bottom)}px`);
}

const waapi = (el: Element) => el.getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSAnimation || a instanceof CSSTransition));

// The session's work at a glance: one checklist per agent and every file changed so far.
export function SessionMap() {
  const sessionId = useStore((s) => s.current);
  const summary = useStore(currentSummary);
  const map = useStore((s) => (s.current ? s.maps[s.current] : undefined));
  const working = useStore((s) => s.status === 'working');
  const busy = working || !!map?.usage.compacting;
  const started = useStore((s) => s.order.length > 0);
  const plan = useStore((s) => {
    const it = s.lastPlan ? s.items[s.lastPlan] : undefined;
    return it?.kind === 'rich' && it.detail.kind === 'plan' ? it.detail.plan : null;
  });
  const agents = useStore((s) => (s.current ? s.panels[s.current]?.agents : undefined) ?? NO_AGENTS);
  const cardsOf = useStore((s) => s.cardsOf);
  const order = useStore((s) => s.order);
  const home = useStore((s) => s.home);
  const files = useMemo(() => changedFiles(cardsOf, order, agents), [cardsOf, order, agents]);
  const groups = useMemo(() => workGroups(plan, agents, working), [plan, agents, working]);
  const [view, setView] = useState<View>(savedView);
  // Groups and "N done" folds the reader opened or closed, per session; the rest keep their defaults.
  const [flip, setFlip] = useState<{ sid: string | null; open: Record<string, boolean> }>({ sid: null, open: NO_OPEN });
  const opened = flip.sid === sessionId ? flip.open : NO_OPEN;
  const [shown, setShown] = useState(false);
  const [full, setFull] = useState(false);
  const fromRef = useRef<DOMRect | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const tasksRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const want = useRef(false);
  const gen = useRef(0);

  const visible = !!sessionId && started;
  const done = groups.reduce((n, g) => n + g.done, 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const add = files.reduce((n, f) => n + f.add, 0);
  const rm = files.reduce((n, f) => n + f.rm, 0);
  const fileCount = plural(files.length, 'file');
  const sub = [total && `${done} of ${total} steps`, files.length && fileCount].filter(Boolean).join(' · ') || 'no changes';
  const cwd = summary?.cwd?.replace(/\/+$/, '') ?? '';
  const root = useMemo(() => fileRoot(files.map((f) => f.path), cwd), [files, cwd]);
  const rel = (p: string) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : tilde(p, home));
  const showTasks = view !== 'files';
  const showFiles = view !== 'tasks';
  const half = showFiles && files.length > 0;

  const pickView = (v: View) => {
    setView(v);
    pref.set('work.view', v);
  };
  const toggle = (key: string, now: boolean) => setFlip({ sid: sessionId, open: { ...opened, [key]: !now } });

  const cardEl = useLayoutVars(cardRef);
  const sheetEl = useLayoutVars(sheetRef);

  // Watching the content too catches growth inside a region capped by max-height.
  useEffect(() => {
    if (!shown) return;
    const ro = new ResizeObserver((es) => es.forEach((e) => fitScroll(e.target.closest('.wk-scroll'))));
    for (const el of [tasksRef.current, filesRef.current]) {
      if (!el) continue;
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => ro.disconnect();
  }, [shown, full, view]);

  // The Agents panel grows, folds and scrolls on its own; the open sheet follows its bottom edge.
  useEffect(() => {
    const panel = document.querySelector('aside.panel');
    if (!shown || !panel) return;
    const ro = new ResizeObserver((es) => es.forEach((e) => tuck(sheetRef.current, e.target)));
    ro.observe(panel);
    return () => ro.disconnect();
  }, [shown]);

  // A new current step scrolls into view inside the list; opening the sheet jumps to the latest current step, or the newest task.
  const curKey = showTasks ? groups.flatMap((g) => g.steps.flatMap((s, i) => (s.status === 'doing' ? [`${g.id}:${i}`] : []))).join('|') : '';
  const seenKey = useRef(curKey);
  const wasShown = useRef(shown);
  useEffect(() => {
    const prev = seenKey.current.split('|');
    seenKey.current = curKey;
    const opening = shown && !wasShown.current;
    wasShown.current = shown;
    const k = !shown ? undefined : opening ? curKey.split('|').filter(Boolean).pop() : curKey ? curKey.split('|').find((x) => !prev.includes(x)) : undefined;
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
    // On open, measure after the 300ms grow so the list has its final height.
    const t = opening ? setTimeout(jump, 320) : 0;
    const raf = opening ? 0 : requestAnimationFrame(jump);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [curKey, shown]);

  // The compact card travels to the side and grows into the sheet, then shrinks back into place.
  const setMap = (open: boolean) => {
    const sheet = sheetRef.current!;
    const card = cardRef.current!;
    const running = waapi(sheet);
    if (open === want.current && !running.length) return;
    want.current = open;
    const g = ++gen.current;
    running.forEach((a) => a.cancel());
    if (open) {
      tuck(sheet, document.querySelector('aside.panel'));
      flushSync(() => setShown(true));
    }
    if (reduceMotion()) {
      if (!open) flushSync(() => setShown(false));
      return;
    }
    const f = card.getBoundingClientRect();
    const d = sheet.getBoundingClientRect();
    const W = innerWidth;
    const fix = { bottom: 'auto', margin: '0' };
    const small = { ...fix, top: f.top + 'px', right: W - f.right + 'px', width: f.width + 'px', height: f.height + 'px', borderRadius: '12px' };
    const big = { ...fix, top: d.top + 'px', right: W - d.right + 'px', width: d.width + 'px', height: d.height + 'px', borderRadius: '12px' };
    const inner = [...sheet.children];
    if (open) {
      sheet.animate([small, big], { duration: 300, easing: FOSI });
      inner.forEach((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 90, easing: FOSI, fill: 'backwards' }));
    } else {
      inner.forEach((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: FOSI, fill: 'forwards' }));
      sheet.animate([big, small], { duration: SPRING.ms, easing: SPRING.easing, fill: 'forwards' }).finished.then(
        () => {
          if (g !== gen.current) return;
          flushSync(() => setShown(false));
          waapi(sheet).forEach((a) => a.cancel());
        },
        () => {},
      );
    }
  };

  const fullscreen = (v: boolean) => {
    fromRef.current = sheetRef.current!.getBoundingClientRect();
    setFull(v);
  };
  useLayoutEffect(() => {
    const from = fromRef.current;
    fromRef.current = null;
    if (from) morphBox(sheetRef.current!, from, full);
  }, [full]);
  // Leaving full screen comes first; the next Esc closes the sheet.
  useEscape(full, () => fullscreen(false));

  const close = () => {
    setFull(false);
    setMap(false);
    topRef.current?.focus({ preventScroll: true });
  };

  // A different session has its own work; the sheet closes without a morph.
  useLayoutEffect(() => {
    if (!want.current) return;
    want.current = false;
    gen.current++;
    if (sheetRef.current) waapi(sheetRef.current).forEach((a) => a.cancel());
    setShown(false);
    setFull(false);
  }, [sessionId, visible]);

  // Esc closes the sheet before it can stop a turn; open popovers and dialogs keep their own Esc.
  const onEsc = useEffectEvent(close);
  useEffect(() => {
    if (!shown || full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector(':popover-open, dialog[open], .panel.full, body[data-watch]')) return;
      e.preventDefault();
      e.stopPropagation();
      onEsc();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown, full]);

  const doing = (groups.find((g) => g.live) ?? groups[0])?.steps.find((s) => s.status === 'doing');
  const peek = doing?.text ?? (busy && map?.now ? `Now · ${map.now}` : null);

  return (
    <>
      <aside
        ref={cardEl} className={`smap rise${shown ? ' open' : ''}`} aria-label="Work" hidden={!visible}
        onClick={() => setMap(true)}
      >
        <div
          ref={topRef} className="sm-top" role="button" tabIndex={0} aria-expanded={shown}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            setMap(!want.current);
          }}
        >
          {busy ? <span key="led" className="sm-led"><Led size="sm" pattern="calm" /></span> : <span key="icon" className="pill-ic"><WorkIcon /></span>}
          <b>Work</b>
          <span className="now"><Flap text={sub} /></span>
        </div>
        {visible && peek && <div className="sm-peek now"><span>{peek}</span></div>}
      </aside>
      <section ref={sheetEl} className={`smx${shown ? ' open' : ''}${full ? ' full' : ''}`} aria-label="Work details">
        <div className="smx-top">
          <b>Work</b><small>{sub}</small>
          <button type="button" className="wt-open" title="Watch the session" onClick={(e) => setWatch(true, e.currentTarget)}>
            <WatchIcon />Watch
          </button>
          <div className="wk-view" role="group" aria-label="Show" style={{ '--i': VIEWS.findIndex(([v]) => v === view) } as CSSProperties}>
            <span className="wk-pill" aria-hidden="true"></span>
            {VIEWS.map(([v, label]) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => pickView(v)}>{label}</button>
            ))}
          </div>
          <button className="min expand" aria-pressed={full} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (esc)' : 'Full screen'} onClick={() => fullscreen(!full)}>
            <ExpandIcon out={full} />
          </button>
          <button className="min" aria-label="Collapse work panel" title="Collapse" onClick={close}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
          </button>
        </div>
        <div className="wk-body">
          {showTasks && (
            <div ref={tasksRef} className={`wk-scroll wk-tasks${half ? ' half' : ''}`} onScroll={(e) => fitScroll(e.currentTarget)}>
              <div className="wk-in">
                {groups.length
                  ? groups.map((g) => <WorkGroup key={g.id} g={g} open={opened[g.id] ?? !g.end} oldOpen={opened[`${g.id}:old`] ?? false} toggle={toggle} />)
                  : <p className="wk-empty">No task list. One shows up on longer jobs.</p>}
              </div>
            </div>
          )}
          {showFiles && (
            <div className="wk-freg">
              <div className="sm-sec wk-sec">
                <span>Changed this session{files.length > 0 && !!root && <span className="wk-root" title={tilde(root, home)}>in {rootLabel(root, home)}</span>}</span>
                {files.length > 0 && <span className="wk-tot">{fileCount} <span className="add">+{add}</span> <span className="del">−{rm}</span></span>}
              </div>
              <div ref={filesRef} className="wk-scroll" onScroll={(e) => fitScroll(e.currentTarget)}>
                <div className="wk-in">
                  {files.length ? (
                    <div className="wk-files">
                      {files.map((f) => {
                        const p = rel(f.path);
                        const cut = p.lastIndexOf('/') + 1;
                        const last = f.owners[f.owners.length - 1];
                        return (
                          <button
                            key={f.path} type="button" className="wk-f" title={`${tilde(f.path, home)} · open the diff`}
                            onClick={(e) => sessionId && openDiff({ sessionId, item: f.item, card: f.card }, f.label, e.currentTarget)}
                          >
                            <span className="wk-p">{cut > 0 && <span className="wk-dir">{p.slice(0, cut)}</span>}<b>{p.slice(cut)}</b></span>
                            <span className="wk-own" title={f.owners.map((o) => o.name).join(', ')}>{last.chip}{f.owners.length > 1 && ` +${f.owners.length - 1}`}</span>
                            <span className="wk-n"><span className="add">+{f.add}</span> <span className="del">−{f.rm}</span></span>
                          </button>
                        );
                      })}
                    </div>
                  ) : <p className="wk-empty">Nothing changed yet.</p>}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
      {/* Narrow windows also show it behind the open sheet (styles.css); a click there closes the sheet. */}
      <div className={`scrim${full ? ' on' : ''}`} aria-hidden="true" onClick={() => (full ? fullscreen(false) : close())} />
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

// One agent's checklist. Folded content stays mounted so its height can animate both ways.
function WorkGroup({ g, open, oldOpen, toggle }: { g: Group; open: boolean; oldOpen: boolean; toggle: (key: string, now: boolean) => void }) {
  const at = g.live && g.done < g.total ? Math.min(g.done + 1, g.total) : g.done;
  const lead = g.steps.findIndex((s) => s.status !== 'done');
  const doneLead = lead < 0 ? g.steps.length : lead;
  // A running list keeps its last 2 done steps in sight; older ones fold into one row.
  const fold = g.live && doneLead >= 4 ? doneLead - 2 : 0;
  const row = (st: Step, i: number) => (
    <li key={i} data-k={`${g.id}:${i}`} className={st.status}>
      <i>{st.status === 'doing' && g.live ? <Led size="sm" pattern="calm" /> : <Check />}</i>
      <span>{st.text}</span>
    </li>
  );
  return (
    <div className={`wk-g${g.end ? ' fin' : ''}${g.live ? ' live' : ''}${open ? '' : ' shut'}`}>
      <button type="button" className="wk-gh" aria-expanded={open} onClick={() => toggle(g.id, open)}>
        {g.end ? <EndMark end={g.end} /> : <i className={`wk-end${g.live ? ' live' : ''}`} aria-hidden="true"></i>}
        <b title={g.title}>{g.title}</b>
        <span className="wk-chip" title={g.name}>{g.chip}</span>
        <span className="wk-gc">{g.end && !open ? plural(g.total, 'step') : `${at} of ${g.total}`}</span>
      </button>
      <div className="wk-fold" inert={!open}>
        <ol className="wk-steps">
          {fold > 0 && (
            <li key="old" className="wk-old">
              <button type="button" aria-expanded={oldOpen} onClick={() => toggle(`${g.id}:old`, oldOpen)}>
                <span className="wk-oi"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M3.5 2 6.5 5l-3 3" /></svg></span>
                <span>{fold} done</span>
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
