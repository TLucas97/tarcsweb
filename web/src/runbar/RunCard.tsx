import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { RunCommand, RunFolder, RunState, RunSuggestion } from '../../../server/runbar/types.ts';
import { currentSummary, useStore } from '../store.ts';
import { send } from '../socket.ts';
import { Check, CopyBtn, PencilIcon, RenameInput, TrashIcon, XIcon, baseName } from '../bits.tsx';
import { MenuList, type MenuApi } from '../MenuList.tsx';
import { attachText, fenced } from '../SendToChat.tsx';
import { openText } from '../Focus.tsx';
import { RunDot } from './RunBar.tsx';
import { isAlive, loadFullLog, runSend, toggleLog, useRun } from './state.ts';

const svg = (size: number, body: ReactNode) => () => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{body}</svg>
);
const PlayIcon = svg(14, <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />);
const StopIcon = svg(12, <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" stroke="none" />);
const OpenIcon = svg(15, <path d="M9 3h4v4M13 3L7.5 8.5M12 9.5V13H3V4h3.5" />);
const LogIcon = svg(15, <path d="M3 4h10M3 8h10M3 12h6" />);
const PinIcon = svg(14, <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />);

// Shortcuts the app stores; commands found in project files can only be hidden.
const STORED = new Set(['agent', 'repeat', 'finder']);
const KIND: Record<RunCommand['kind'], string> = { service: 'Service', prod: 'Production', action: 'Action' };

function span(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

// Uptimes and "done" marks move on while the card is open.
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const title = (c: RunCommand) => `${c.build ? `${c.build} && ` : ''}${c.command}${c.cwd ? `  (in ${c.cwd})` : ''}`;
const pinnedFirst = (cs: RunCommand[]) => [...cs].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
const toneOf = (r: RunState | undefined) => (r?.phase === 'running' ? 'on' : r?.phase === 'starting' ? 'busy' : r?.phase === 'failed' || r?.phase === 'blocked' ? 'bad' : 'idle');
const closeCard = () => document.getElementById('rbCard')?.hidePopover();

function sub(c: RunCommand, r: RunState | undefined, now: number) {
  if (!r || r.phase === 'stopped') return c.kind === 'prod' ? 'Builds, then starts' : 'Stopped';
  if (r.phase === 'blocked') return `Port :${r.holder?.port} is busy`;
  if (r.phase === 'starting') {
    if (r.step && r.step[0] < r.step[1]) return `Building… step ${r.step[0]} of ${r.step[1]}`;
    return c.port ? `Starting… waiting for :${c.port}` : 'Starting…';
  }
  if (r.phase === 'running') return [r.ports.map((p) => `:${p}`).join(' '), c.kind === 'prod' ? 'production' : span(now - r.startedAt), r.mb ? `${r.mb} MB` : ''].filter(Boolean).join(' · ');
  const ago = r.endedAt ? ` · ${span(now - r.endedAt)} ago` : '';
  if (r.phase === 'failed') return `${c.kind === 'prod' ? (r.step?.[0] === 2 ? 'Start failed' : 'Build failed') : 'Failed'} · exit ${r.exit ?? '?'}${ago}`;
  return `Exited${ago}`;
}

function Log() {
  const text = useRun((s) => s.log?.text ?? '');
  // column-reverse keeps the newest line in view without reading scroll sizes.
  return <div className="rb-log mono"><pre>{text || 'Waiting for output…'}</pre></div>;
}

function LogBtn({ c }: { c: RunCommand }) {
  const open = useRun((s) => s.log?.id === c.id);
  return (
    <button type="button" className="rb-ib" aria-pressed={open} aria-label={`${open ? 'Hide' : 'Show'} the ${c.label} log`} title="Log" onClick={() => toggleLog(c.id)}>
      <LogIcon />
    </button>
  );
}

const StopBtn = ({ c }: { c: RunCommand }) => (
  <button type="button" className="rb-ib stop" aria-label={`Stop ${c.label}`} title="Stop" onClick={() => runSend({ type: 'run-stop', id: c.id })}><StopIcon /></button>
);

function OpenBtn({ c, r }: { c: RunCommand; r: RunState | undefined }) {
  const port = r?.phase === 'running' && c.web ? r.ports[0] : undefined;
  if (!port) return null;
  const url = `http://localhost:${port}/`;
  return <button type="button" className="rb-ib" aria-label={`Open ${c.label} in Chrome`} title={`Open ${url} in Chrome`} onClick={() => send({ type: 'run-open', url })}><OpenIcon /></button>;
}

// Who holds the port a run needs, with a way out.
function Holder({ c, r }: { c: RunCommand; r: RunState }) {
  const h = r.holder!;
  return (
    <div className="rb-warn">
      <span>Port :{h.port} is used by <b className="mono">{h.name}</b>{h.pid ? ` (pid ${h.pid})` : ''}.{r.errors && r.phase === 'blocked' ? ` ${r.errors}` : ''}</span>
      {r.phase === 'blocked' && <button type="button" className="hu-act" onClick={() => runSend({ type: 'run-stop', id: c.id })}>Cancel</button>}
      {h.stoppable && <button type="button" className="hu-act rb-danger" onClick={() => runSend({ type: 'run-free-port', id: c.id, pid: h.pid })}>Stop it and start</button>}
    </div>
  );
}

// A failed run's error lines, ready to go to the chat; Attach only fills the composer.
function Failure({ c, r }: { c: RunCommand; r: RunState }) {
  const folder = useRun((s) => s.folder?.folder ?? '');
  const text = r.errors ?? '';
  const attach = () => {
    const step = c.kind === 'prod' && r.step?.[0] !== 2 ? c.build : c.command;
    if (attachText(`${c.label} failed in ${baseName(folder)} (exit ${r.exit ?? '?'}).\n\n$ ${step}\n${fenced(text)}`)) closeCard();
    else useStore.setState({ notice: 'Open a session to attach the log', noticeInfo: true });
  };
  const full = async (e: MouseEvent<HTMLButtonElement>) => {
    const from = document.querySelector('.rb-pill') ?? e.currentTarget;
    const paste = await loadFullLog(c.id);
    closeCard();
    openText({ paste, label: `${c.label} log` }, from);
  };
  return (
    <>
      {text && <div className="rb-log err mono"><pre>{text}</pre></div>}
      <div className="rb-bar">
        <button type="button" className="hu-act allow" onClick={attach}>Attach to chat</button>
        <button type="button" className="hu-act" onClick={full}>Full log</button>
        {text && <CopyBtn text={text} what="error lines" label={false} />}
      </div>
    </>
  );
}

function ServiceRow({ c, r, now }: { c: RunCommand; r: RunState | undefined; now: number }) {
  const logOpen = useRun((s) => s.log?.id === c.id);
  const alive = isAlive(r);
  return (
    <>
      <div className="rb-row">
        <RunDot tone={toneOf(r)} />
        <span className="rb-nm" title={title(c)}><span>{c.label}</span><small className={r?.phase === 'failed' ? 'err' : undefined}>{sub(c, r, now)}</small></span>
        <OpenBtn c={c} r={r} />
        {r && r.phase !== 'blocked' && <LogBtn c={c} />}
        {alive ? <StopBtn c={c} /> : <button type="button" className="rb-ib go" aria-label={`Start ${c.label}`} title={title(c)} onClick={() => runSend({ type: 'run-start', id: c.id })}><PlayIcon /></button>}
      </div>
      {r?.holder && <Holder c={c} r={r} />}
      {logOpen ? <Log /> : r?.phase === 'failed' && <Failure c={c} r={r} />}
    </>
  );
}

function ProdRow({ c, r, now, devUp }: { c: RunCommand; r: RunState | undefined; now: number; devUp: number }) {
  const logOpen = useRun((s) => s.log?.id === c.id);
  const [warn, setWarn] = useState(false);
  const alive = isAlive(r);
  // One heavy thing at a time: a build beside a running dev server asks first.
  const go = (sure: boolean) => {
    if (devUp > 0 && !sure) return setWarn(true);
    setWarn(false);
    runSend({ type: 'run-start', id: c.id });
  };
  return (
    <>
      <div className="rb-row">
        <RunDot tone={toneOf(r)} />
        <span className="rb-nm" title={title(c)}><span>{c.label}</span><small className={r?.phase === 'failed' ? 'err' : undefined}>{sub(c, r, now)}</small></span>
        <OpenBtn c={c} r={r} />
        {r && r.phase !== 'blocked' && <LogBtn c={c} />}
        {alive ? <StopBtn c={c} /> : <button type="button" className="hu-act" title={title(c)} onClick={() => go(false)}>{r?.phase === 'failed' ? 'Retry' : 'Build & start'}</button>}
      </div>
      {warn && !alive && (
        <div className="rb-warn">
          <span>{devUp === 1 ? 'A dev server is running.' : `${devUp} dev servers are running.`} Build anyway?</span>
          <button type="button" className="hu-act" onClick={() => setWarn(false)}>Cancel</button>
          <button type="button" className="hu-act allow" onClick={() => go(true)}>Build</button>
        </div>
      )}
      {r?.holder && <Holder c={c} r={r} />}
      {logOpen ? <Log /> : r?.phase === 'failed' && <Failure c={c} r={r} />}
    </>
  );
}

function ActionRow({ c, r, now }: { c: RunCommand; r: RunState | undefined; now: number }) {
  const logOpen = useRun((s) => s.log?.id === c.id);
  const [confirm, setConfirm] = useState(false);
  const alive = isAlive(r);
  const run = () => {
    setConfirm(false);
    runSend({ type: 'run-start', id: c.id });
  };
  // A destructive action asks on every click.
  if (confirm) {
    return (
      <div className="rb-row one rb-confirm">
        <span>Run “{c.label}”? It can delete data.</span>
        <button type="button" className="hu-act" onClick={() => setConfirm(false)}>Cancel</button>
        <button type="button" className="hu-act rb-danger" onClick={run}>Run</button>
      </div>
    );
  }
  const recent = r?.phase === 'done' && !!r.endedAt && now - r.endedAt < 60_000;
  const failed = r?.phase === 'failed';
  return (
    <>
      <div className="rb-row one">
        {alive && <RunDot tone="busy" />}
        <span className="rb-nm" title={title(c)}><span>{c.label}{c.destructive && <em className="rb-tag">deletes data</em>}</span></span>
        <span className={`rb-cmd mono${failed ? ' err' : ''}`} title={title(c)}>{alive ? 'Running…' : failed ? `Failed · exit ${r!.exit ?? '?'}` : recent ? 'Done' : c.command}</span>
        {r && <LogBtn c={c} />}
        {alive ? <StopBtn c={c} /> : (
          <button type="button" className="rb-ib go" aria-label={`Run ${c.label}`} title={title(c)} onClick={() => (c.destructive ? setConfirm(true) : run())}>
            {recent ? <Check /> : <PlayIcon />}
          </button>
        )}
      </div>
      {logOpen ? <Log /> : failed && <Failure c={c} r={r!} />}
    </>
  );
}

// Backticks in why mark the command.
function Why({ s }: { s: RunSuggestion }) {
  const parts = s.why.split('`');
  return <small>{parts.map((p, i) => (i % 2 ? <code key={i} className="mono">{p}</code> : p))}</small>;
}

// The whole command wraps on its own line, since Add accepts exactly what is shown.
function Suggestion({ s }: { s: RunSuggestion }) {
  return (
    <div className="rb-sug" title={title(s)}>
      <span className="rb-nm">
        <span>{s.label}{s.destructive && <em className="rb-tag">deletes data</em>}</span>
        <Why s={s} />
        <code className="mono rb-sug-cmd">{title(s)}</code>
      </span>
      <button type="button" className="hu-act" onClick={() => runSend({ type: 'run-suggestion', id: s.id, accept: true, command: s.command, cwd: s.cwd })}>Add</button>
      <button type="button" className="rb-ib" aria-label={`Dismiss ${s.label}`} title="Dismiss" onClick={() => runSend({ type: 'run-suggestion', id: s.id, accept: false })}><XIcon /></button>
    </div>
  );
}

// Every command, hidden ones too: a click shows or hides it; pin, rename and remove sit on the row.
function EditMenu({ f, runs }: { f: RunFolder; runs: Map<string, RunState> }) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const api = useRef<MenuApi>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const all = pinnedFirst(f.commands);

  useEffect(() => {
    const p = pop.current!;
    const place = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open') return setRenaming(null);
      const r = btn.current!.getBoundingClientRect();
      p.style.left = Math.max(12, Math.min(r.right - 320, innerWidth - 332)) + 'px';
      // Opens toward the larger space and never past the window.
      const below = innerHeight - r.bottom - 18;
      const up = below < 240 && r.top > below;
      p.style.top = up ? 'auto' : r.bottom + 6 + 'px';
      p.style.bottom = up ? innerHeight - r.top + 6 + 'px' : 'auto';
      p.style.maxHeight = Math.min(420, up ? r.top - 18 : below) + 'px';
    };
    p.addEventListener('beforetoggle', place);
    return () => p.removeEventListener('beforetoggle', place);
  }, []);

  const edit = (c: RunCommand, e: { hidden?: boolean; pinned?: boolean; label?: string }) => runSend({ type: 'run-edit', id: c.id, edit: e });
  const own = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const onKey = (e: KeyboardEvent) => {
    if (renaming) return;
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (d) api.current?.move(d);
    else if (e.key === 'Enter' && all[api.current?.at() ?? -1]) edit(all[api.current!.at()]!, { hidden: !all[api.current!.at()]!.hidden });
    else return;
    e.preventDefault();
  };

  const render = (i: number, selected: boolean) => {
    const c = all[i]!;
    return (
      <div role="option" aria-selected={selected} data-i={i} className="sl-row rb-ed" onClick={() => renaming !== c.id && edit(c, { hidden: !c.hidden })}>
        <span className="rb-ed-nm">
          <span className="rb-ck" aria-label={c.hidden ? 'Hidden' : 'Shown'}>{!c.hidden && <Check />}</span>
          {renaming === c.id
            ? <RenameInput value={c.label} onDone={(n) => { if (n) edit(c, { label: n }); setRenaming(null); }} />
            : <span className="rb-ed-lbl">{c.label}</span>}
        </span>
        <span className="rb-ed-acts">
          <button type="button" className="rb-ib" aria-pressed={!!c.pinned} aria-label={`${c.pinned ? 'Unpin' : 'Pin'} ${c.label}`} title={c.pinned ? 'Unpin' : 'Pin to the top'} onClick={own(() => edit(c, { pinned: !c.pinned }))}><PinIcon /></button>
          <button type="button" className="rb-ib" aria-label={`Rename ${c.label}`} title="Rename" onClick={own(() => setRenaming(c.id))}><PencilIcon /></button>
          {STORED.has(c.source) && (
            <button type="button" className="rb-ib" aria-label={`Remove ${c.label}`} title={isAlive(runs.get(c.id)) ? 'Stop it first' : 'Remove'} disabled={isAlive(runs.get(c.id))} onClick={own(() => runSend({ type: 'run-remove', id: c.id }))}><TrashIcon /></button>
          )}
        </span>
        <small>{KIND[c.kind]} · {c.source}{c.hidden ? ' · hidden' : ''}</small>
      </div>
    );
  };

  return (
    <>
      <button ref={btn} type="button" className="hu-act" popoverTarget="rbEdit" aria-haspopup="listbox" title={`Found in ${f.sources.join(', ') || 'no project files'}. Edit, pin or hide commands`}>Edit</button>
      <div className="pop rb-edit" id="rbEdit" popover="auto" ref={pop} aria-label="Edit commands" onKeyDown={onKey} tabIndex={-1}>
        {all.length > 0 && <MenuList count={all.length} reset={f.folder} api={api} keyOf={(i) => all[i]!.id} render={render} />}
        <button type="button" className="mi rb-find" disabled={f.finding} onClick={() => runSend({ type: 'run-find' })}>
          <span className="nm2">{f.finding ? 'Looking for commands…' : 'Find commands'}</span>
          <small>A small model reads the project files and suggests what was missed</small>
        </button>
      </div>
    </>
  );
}

export function RunCard({ open }: { open: boolean }) {
  const f = useRun((s) => s.folder);
  const summary = useStore(currentSummary);
  const now = useNow(open);
  if (!f || !summary || f.folder !== summary.cwd) return <p className="rb-empty">Reading the project files…</p>;
  const runs = new Map(f.runs.map((r) => [r.id, r]));
  const visible = pinnedFirst(f.commands.filter((c) => !c.hidden));
  const services = visible.filter((c) => c.kind === 'service');
  const prod = visible.filter((c) => c.kind === 'prod');
  const actions = visible.filter((c) => c.kind === 'action');
  const devUp = f.elsewhere + f.commands.filter((c) => c.kind === 'service' && isAlive(runs.get(c.id))).length;
  const meta = [summary.branch, f.pm].filter(Boolean).join(' · ');
  return (
    <>
      <div className="rb-hd">
        <b>{baseName(f.folder)}</b>
        {meta && <span className="rb-br mono">{meta}</span>}
        <span className="rb-sp" />
        <EditMenu f={f} runs={runs} />
        {services.length > 0 && (
          <button type="button" className="hu-act" disabled={services.every((c) => isAlive(runs.get(c.id)))} onClick={() => runSend({ type: 'run-start-all' })}>Start all</button>
        )}
      </div>
      {services.length > 0 && (
        <section aria-label="Services">
          <h3 className="rb-sec">Services</h3>
          {services.map((c) => <ServiceRow key={c.id} c={c} r={runs.get(c.id)} now={now} />)}
        </section>
      )}
      {prod.length > 0 && (
        <section aria-label="Production, local">
          <h3 className="rb-sec">Production, local</h3>
          {prod.map((c) => <ProdRow key={c.id} c={c} r={runs.get(c.id)} now={now} devUp={devUp} />)}
        </section>
      )}
      {actions.length > 0 && (
        <section aria-label="Actions">
          <h3 className="rb-sec">Actions</h3>
          {actions.map((c) => <ActionRow key={c.id} c={c} r={runs.get(c.id)} now={now} />)}
        </section>
      )}
      {!visible.length && (
        <div className="rb-empty">
          <p>{f.finding ? 'Looking for commands…' : f.commands.length ? 'Every command is hidden. Show them from Edit.' : 'No commands found in this folder.'}</p>
          {!f.finding && !f.commands.length && <button type="button" className="hu-act allow" onClick={() => runSend({ type: 'run-find' })}>Find commands</button>}
        </div>
      )}
      {f.suggestions.map((s) => <Suggestion key={s.id} s={s} />)}
      {f.findError && <p className="rb-note" role="status">{f.findError}</p>}
    </>
  );
}
