import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentRow, FileTouch, ProcRow } from '../../server/protocol.ts';
import { cardsOf, currentSummary, useStore, type ProcLog as ProcLogState } from './store.ts';
import { openLogView, useFocus } from './Focus.tsx';
import { send } from './socket.ts';
import { AgentsIcon, Check, ExpandIcon, GLYPH, morphBox, reduceMotion, tilde, useEscape, useTicker } from './bits.tsx';
import { Markdown } from './Markdown.tsx';
import { Card as ChangeCardBtn } from './Changes.tsx';
import { legacyText, loadedText, useAgentTexts } from './panel.ts';
import { isPills, usePills } from './narrow.ts';
import { useLayoutVars } from './layoutVars.ts';
import { useAutosize } from './autosize.ts';
import { LedBar, activityOf } from './led.tsx';
import { Robot } from './robot.tsx';
import { Flap } from './flap.tsx';

const live = (s: string) => s === 'running' || s === 'waiting';
const LogView = lazy(() => import('./LogView.tsx'));

// "42s", "4m53", "1h12m", like the terminal mod.
export function dur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const tok = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
// "Codex · gpt-5.5 · low", so Codex rows stand apart from Claude's. A workflow run has no model: its agent count, and its agents their phase.
const modelLine = (a: AgentRow) => {
  if (a.kind === 'workflow') return `${a.agents ?? 0} agent${a.agents === 1 ? '' : 's'}`;
  if (a.parent) return a.phase || 'workflow agent';
  return `${a.kind === 'codex' ? 'Codex · ' : ''}${a.model}${a.effort ? ` · ${a.effort}` : ''}`;
};
const WfTag = ({ a }: { a: AgentRow }) => (a.kind === 'workflow' ? <span className="wf-tag">workflow</span> : null);

// A row's long text, loaded while it is shown and again whenever its rev moves.
function useAgentText(sessionId: string, a: AgentRow, on = true) {
  useEffect(() => {
    if (on) send({ type: 'agent-load', sessionId, id: a.id });
  }, [on, sessionId, a.id, a.rev]);
  const loaded = useAgentTexts((s) => (on ? loadedText(s, sessionId, a.id) : undefined));
  return on ? loaded ?? legacyText(sessionId, a.id) : undefined;
}

const elapsed = (x: { startedAt: number; endedAt: number | null }, now: number) => dur((x.endedAt ?? now) - x.startedAt);

function hl(s: string, q: string): ReactNode {
  const i = q ? s.toLowerCase().indexOf(q) : -1;
  if (i < 0) return s;
  return <>{s.slice(0, i)}<mark>{s.slice(i, i + q.length)}</mark>{s.slice(i + q.length)}</>;
}

// One clock for every live timer; it only ticks while something runs and the tab is visible.
const useNow = (on: boolean) => useTicker(on, 1000);
// Row timers change every second, so they land straight on the next digit instead of scrambling.
const TIMER_HOPS: [number, number] = [0, 0];

// A process LED blinks only when it fails while on screen, not every time a failed row mounts.
function ProcLed({ failed }: { failed: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const was = useRef(failed);
  useEffect(() => {
    if (failed && !was.current && !reduceMotion()) {
      ref.current?.animate([{ opacity: 1, easing: 'steps(1)' }, { opacity: 0.1, offset: 0.5, easing: 'steps(1)' }, { opacity: 1 }], { duration: 900, iterations: 2, pseudoElement: '::before' });
    }
    was.current = failed;
  }, [failed]);
  return <span ref={ref} className="dot pled"></span>;
}

const Stop = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x=".5" y=".5" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
);

function StateIcon({ a }: { a: AgentRow }) {
  if (live(a.state)) return <span className="g gled"><Robot size={GLYPH} state={a.state === 'waiting' ? 'needs' : activityOf(a.now)} /></span>;
  if (a.state === 'done') return <span className="ic ok"><Check /></span>;
  // The fault X at rest: a finished row never animates.
  if (a.state === 'failed') return <span className="g gled" title="Failed"><Robot size={GLYPH} state="fault" still /></span>;
  return <span className="ic off" title="Stopped"><Stop /></span>;
}

function FileChip({ f, q, full, now }: { f: FileTouch; q: string; full: boolean; now: number }) {
  const name = full ? hl(f.path, q) : f.path.split('/').pop();
  return (
    <span title={f.path}>
      {name}
      {f.mode === 'edited' && <> <span className="add">+{f.add}</span>{(f.rm > 0 || full) && <> <span className="rm">−{f.rm}</span></>}</>}
      {full && <><span className="mode">{f.mode}</span><span className="ago">{now - f.at < 5000 ? 'now' : dur(now - f.at)}</span></>}
    </span>
  );
}

function stopAgent(sessionId: string, a: AgentRow) {
  if (a.main) send({ type: 'interrupt', sessionId });
  else if (a.taskId) send({ type: 'stop-task', sessionId, taskId: a.taskId });
}

function Agent({ a, q, open, onToggle, now, sessionId }: { a: AgentRow; q: string; open: boolean; onToggle: () => void; now: number; sessionId: string }) {
  const running = live(a.state);
  const files = q ? a.files.filter((f) => f.path.toLowerCase().includes(q)) : a.files;
  const full = !!q || open;
  const shown = full ? files : files.slice(0, 2);
  const more = files.length - shown.length;
  const said = a.said;
  const detail = useAgentText(sessionId, a, open);
  // Workflow runs and their agents stream no text; their report is what there is to read.
  const text = detail?.text || (a.kind === 'workflow' || a.parent ? detail?.result : undefined);
  const doing = running ? a.now : said || a.now;
  const s = a.steps;
  const left = s && s.avgMs !== null && s.done < s.total ? s.avgMs * (s.total - s.done) - (now - s.lastAt) : null;
  const pct = (n: number, d: number) => `${Math.min(100, Math.max(2, (n / d) * 100))}%`;
  const stepText = s ? `${s.done}/${s.total}${left !== null && left > 0 ? ` · ~${dur(left)} left` : ''}` : '';
  return (
    <div
      className={`ag${a.state === 'waiting' ? ' hot' : ''}${running ? ' run' : ' done'}${a.kind === 'workflow' ? ' wf' : ''}`}
      role="button" tabIndex={0} aria-expanded={open}
      onClick={(e) => {
        // Selecting text in the expanded output should not fold the row.
        if ((e.target as Element).closest('.said.full') && getSelection()?.toString()) return;
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onToggle();
      }}
    >
      {/* Identity (name, model, task) and activity (progress, time, output, files) are separate zones; styles.css places them by panel width. */}
      <div className="ar">
        <StateIcon a={a} />
        <b>{hl(a.name, q)}</b>
        <WfTag a={a} />
      </div>
      <div className="act">
        {running && s && (
          <>
            <LedBar done={s.done} total={s.total} />
            <div className="steps"><Flap text={stepText} /></div>
          </>
        )}
        <span className="t"><Flap text={a.state === 'waiting' ? 'needs you' : elapsed(a, now)} hops={TIMER_HOPS} /></span>
        {a.canStop && (
          <button className="ag-stop" aria-label={a.main ? 'Stop this turn' : `Stop ${a.name}`} title={a.main ? 'Stop this turn' : 'Stop agent'}
            onClick={(e) => { e.stopPropagation(); stopAgent(sessionId, a); }}>
            <Stop />
          </button>
        )}
      </div>
      <div className="meta">
        <span>{hl(modelLine(a), q)}</span>
        {a.tokens !== null && (
          <span className="ctx">·{a.window && <i><b style={{ width: pct(a.tokens, a.window) }}></b></i>}{tok(a.tokens)}{a.window && `/${tok(a.window)}`}</span>
        )}
        {a.followUpCount > 0 && (
          <span className="fu" title={a.lastFollowUp ?? undefined}>· {a.followUpCount} follow-up{a.followUpCount > 1 ? 's' : ''}</span>
        )}
      </div>
      {doing && <div className="doing">{hl(doing, q)}</div>}
      {open && text ? <div className="said full">{text}</div> : running && !a.main && said && said !== doing && <div className="said">{said}</div>}
      {shown.length > 0 && (
        <div className={`files mono${full ? ' full' : ''}`}>
          {shown.map((f) => <FileChip key={f.path} f={f} q={q} full={full} now={now} />)}
          {more > 0 && <span>+{more}</span>}
        </div>
      )}
    </div>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Full screen: agents in start order on one time axis, and what the picked one was asked and reported.
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const AXIS_STEPS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120].map((m) => m * 60_000);

function AgentsFull({ agents, procs, now, sessionId, sel, onSel }: {
  agents: AgentRow[]; procs: ProcRow[]; now: number; sessionId: string; sel: string | null; onSel: (id: string) => void;
}) {
  const log = useStore((s) => s.log);
  // The main thread shows in the conversation, so the timeline lists subagents only.
  const order = agents.filter((a) => !a.main).sort((x, y) => x.startedAt - y.startedAt);
  const subs = order.filter((a) => !a.main);
  const t0 = subs.length ? Math.min(...subs.map((a) => a.startedAt)) : now;
  const t1 = Math.max(t0 + 1000, ...subs.map((a) => a.endedAt ?? now));
  // The axis snaps to round lengths, so running bars grow rightward instead of the whole chart rescaling every tick.
  // Wall-clock labels and a "now" line make it read as a timeline: a bar sits where its agent started.
  const span = AXIS_STEPS.find((s) => s >= (t1 - t0) * 1.05) ?? Math.ceil(((t1 - t0) * 1.05) / 3_600_000) * 3_600_000;
  const nowAt = Math.min(100, ((now - t0) / span) * 100);
  const proc = sel?.startsWith('proc:') ? procs.find((p) => `proc:${p.id}` === sel) : undefined;
  const picked = proc ? undefined : order.find((a) => a.id === sel) ?? subs.findLast((a) => live(a.state)) ?? subs.at(-1) ?? order[0];
  // A process opens its log in the detail pane, never as a popover over the full view.
  const pickProc = (p: ProcRow) => {
    onSel(`proc:${p.id}`);
    openLog(sessionId, p.id, true);
  };
  return (
    <div className="afull">
      <div className="tline">
        {order.map((a) => {
          const i = subs.indexOf(a);
          const left = ((a.startedAt - t0) / span) * 100;
          const width = (((a.endedAt ?? now) - a.startedAt) / span) * 100;
          return (
            <button key={a.id} className={`tlr${a === picked ? ' sel' : ''}${live(a.state) ? ' run' : ''}${a.parent ? ' kid' : ''}`} onClick={() => onSel(a.id)}>
              <span className="no">{a.main ? '' : i + 1}</span>
              <span className="st"><StateIcon a={a} /></span>
              <span className="nm"><b>{a.name}</b><small>{a.kind === 'workflow' ? `workflow · ${modelLine(a)}` : modelLine(a)}</small></span>
              {a.main ? <span className="gantt none"></span> : (
                <span className="gantt" title={`Started ${hhmm(a.startedAt)} · ${live(a.state) ? 'running' : 'ran'} ${elapsed(a, now)}`}>
                  <i className={a.state} style={{ left: `${Math.max(0, Math.min(100, left))}%`, width: `${Math.max(0.6, Math.min(100 - left, width))}%` }}></i>
                  <em className="now" style={{ left: `${nowAt}%` }}></em>
                </span>
              )}
              <span className="t">{a.state === 'waiting' ? 'needs you' : elapsed(a, now)}</span>
            </button>
          );
        })}
        {subs.length > 0 && <div className="axis"><span>{hhmm(t0)}</span><span>{hhmm(t0 + span / 2)}</span><span>{hhmm(t0 + span)}</span></div>}
        {procs.length > 0 && <div className="tl-sec">Processes</div>}
        {procs.map((p) => (
          <button key={p.id} className={`tlr proc ${PROC_CLASS[p.state]}${proc === p ? ' sel' : ''}`} onClick={() => pickProc(p)}>
            <span className="no"></span>
            <span className="st"><ProcLed failed={p.state === 'failed'} /></span>
            <span className="nm" title={p.command}><b className={p.label ? undefined : 'mono'}>{procName(p)}</b><small>{p.state === 'failed' && p.exit ? `exit ${p.exit}` : PROC_LABEL[p.state]}</small></span>
            <span className="gantt none"></span>
            <span className="t">{elapsed(p, now)}</span>
          </button>
        ))}
      </div>
      {proc && log?.inline && log.taskId === proc.id && <div className="adet ilog"><LogBody key={proc.id} log={log} /></div>}
      {picked && <AgentDetail key={picked.id} a={picked} now={now} sessionId={sessionId} offset={picked.main ? null : picked.startedAt - t0} />}
    </div>
  );
}

// This agent's diff cards from every turn, each opening the full diff.
function AgentChanges({ owner, sessionId }: { owner: string; sessionId: string }) {
  const all = useStore((s) => cardsOf(s, owner));
  const pairs = all.filter(([, c]) => c.files.length);
  if (!pairs.length) return null;
  return (
    <section>
      <h4>Changes</h4>
      <div className="dv-strip">
        {pairs.map(([id, c]) => <ChangeCardBtn key={c.id} c={c} item={id} sessionId={sessionId} last={false} />)}
      </div>
    </section>
  );
}

function AgentDetail({ a, now, sessionId, offset }: { a: AgentRow; now: number; sessionId: string; offset: number | null }) {
  const running = live(a.state);
  const t = useAgentText(sessionId, a);
  const text = t?.text ?? '';
  const report = t?.result ?? (running ? null : text.trim() || null);
  return (
    <div className="adet">
      <div className="ad-h">
        <StateIcon a={a} />
        <b>{a.name}</b>
        <WfTag a={a} />
        {a.canStop && <button className="btnx" onClick={() => stopAgent(sessionId, a)}><Stop /> {a.main ? 'Stop turn' : a.kind === 'workflow' ? 'Stop workflow' : 'Stop agent'}</button>}
      </div>
      <div className="ad-m">
        <span>{modelLine(a)}</span>
        <span>{a.state === 'waiting' ? 'needs you' : running ? `running ${elapsed(a, now)}` : `${a.state} in ${elapsed(a, now)}`}</span>
        {offset !== null && <span>started at {clock(offset)}</span>}
        {a.tokens !== null && <span>{tok(a.tokens)} tokens</span>}
      </div>
      {/* What it was asked and said reads on the left; what it touched sits beside it once the pane is wide (styles.css). */}
      <div className="ad-cols">
        <div className="ad-main">
          {running && a.now && <div className="ad-now">{a.now}</div>}
          {a.canMessage && <AgentMessage a={a} sessionId={sessionId} />}
          {t?.task && (
            <section>
              <h4>Task</h4>
              <div className="ad-task md"><Markdown text={t.task} /></div>
            </section>
          )}
          {(t?.followUps.length ?? 0) > 0 && (
            <section>
              <h4>Follow-ups</h4>
              {t!.followUps.map((f, i) => (
                <div key={i} className="ad-task fu"><small>{hhmm(f.at)}</small>{f.text}</div>
              ))}
            </section>
          )}
          <section>
            <h4>{report ? 'Report' : 'Output so far'}</h4>
            {!t ? <div className="ad-empty">Loading…</div>
              : report ? <div className="ad-rep"><Markdown text={report} /></div>
              : text.trim() ? <div className="ad-task live">{text}</div>
              : <div className="ad-empty">{running ? 'Nothing written yet' : 'No report'}</div>}
          </section>
        </div>
        <div className="ad-side">
          <AgentChanges owner={a.id} sessionId={sessionId} />
          {a.files.length > 0 && <AgentFiles files={a.files} now={now} />}
        </div>
      </div>
    </div>
  );
}

// One row per file, relative to the session folder; the folder part gives way first so the name stays readable.
function AgentFiles({ files, now }: { files: FileTouch[]; now: number }) {
  const cwd = useStore((s) => currentSummary(s)?.cwd?.replace(/\/+$/, '') ?? '');
  const home = useStore((s) => s.home);
  return (
    <section>
      <h4>Files <span className="ad-cnt">{files.length}</span></h4>
      <ul className="ad-files">
        {files.map((f) => {
          const p = cwd && f.path.startsWith(cwd + '/') ? f.path.slice(cwd.length + 1) : tilde(f.path, home);
          const cut = p.lastIndexOf('/') + 1;
          return (
            <li key={f.path} className="ad-f" title={tilde(f.path, home)}>
              <span className="wk-p">{cut > 0 && <span className="wk-dir">{p.slice(0, cut)}</span>}<b>{p.slice(cut)}</b></span>
              {f.mode === 'edited'
                ? <span className="wk-n"><span className="add">+{f.add}</span> <span className="rm">−{f.rm}</span></span>
                : <span className="ad-fm">read</span>}
              <span className="ad-fa">{now - f.at < 5000 ? 'now' : dur(now - f.at)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// A Codex agent gets it directly; a Claude subagent gets it relayed by the main thread.
function AgentMessage({ a, sessionId }: { a: AgentRow; sessionId: string }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useAutosize(area, text);
  const submit = () => {
    const t = text.trim();
    if (!t || !send({ type: 'agent-message', sessionId, agentId: a.id, text: t })) return;
    setText('');
    setSent(true);
    setTimeout(() => setSent(false), 2500);
  };
  return (
    <form className="ad-msg" onSubmit={(e) => (e.preventDefault(), submit())}>
      <textarea
        ref={area} rows={1} value={text} placeholder={`Message ${a.name}`} aria-label={`Message ${a.name}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
          if (e.key === 'Escape') (e.stopPropagation(), e.currentTarget.blur());
        }}
      />
      <button type="submit" className="btnx" disabled={!text.trim()}>{sent ? 'Sent' : 'Send'}</button>
      <small>{a.kind === 'codex' ? (live(a.state) ? 'Codex reads it during its current turn' : 'Codex starts a new turn with it') : 'The main thread passes it to the agent'}</small>
    </form>
  );
}

const PROC_LABEL = { running: 'running', done: 'done', failed: 'failed', stopped: 'stopped' } as const;
const PROC_CLASS = { running: 'run', done: 'done', failed: 'fail', stopped: 'off' } as const;

// The Bash description when there is one; otherwise the command without its leading `cd <dir> &&`.
export const procName = (p: ProcRow) => p.label || p.command.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '');
// Running and done read from the dot and the clock; only the outcomes worth a look get a word.
const procNote = (p: ProcRow) => (p.state === 'failed' ? (p.exit ? `exit ${p.exit}` : 'failed') : p.state === 'stopped' ? 'stopped' : null);
// Finished rows only need a rough age, so the column stays short and quiet.
const roughDur = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? `${Math.max(0, Math.floor(ms / 1000))}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
};

function Procs({ procs, q, now, sessionId }: { procs: ProcRow[]; q: string; now: number; sessionId: string }) {
  const list = q ? procs.filter((p) => p.command.toLowerCase().includes(q) || !!p.label?.toLowerCase().includes(q)) : procs;
  const running = procs.filter((p) => p.state === 'running').length;
  if (!list.length) return null;
  return (
    <div className="procs">
      <div className="pr-h"><span>Processes</span><span><Flap text={`${running} running`} /></span></div>
      <div className="pr-list">
        {list.map((p) => {
          const name = procName(p);
          const note = procNote(p);
          return (
            <div key={p.id} className={`pr ${PROC_CLASS[p.state]}`}>
              <button className="pr-open" data-proc={p.id} title={p.command} aria-label={`${name}, ${note ?? PROC_LABEL[p.state]}`} onClick={() => openLog(sessionId, p.id)}>
                <ProcLed failed={p.state === 'failed'} />
                <span className={`c${p.label ? '' : ' mono'}`}>{hl(name, q)}</span>
                {note && <span className="i">{note}</span>}
                <span className="t"><Flap text={p.state === 'running' ? elapsed(p, now) : roughDur((p.endedAt ?? now) - p.startedAt)} hops={TIMER_HOPS} /></span>
              </button>
              {p.state === 'running' && (
                <button className="pr-stop" aria-label={`Stop ${name}`} title="Stop" onClick={() => send({ type: 'stop-task', sessionId, taskId: p.id })}><Stop /></button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function openLog(sessionId: string, taskId: string, inline = false) {
  useStore.setState({ log: { sessionId, taskId, text: '', truncated: false, source: null, inline } });
  send({ type: 'watch-log', sessionId, taskId });
}

export function closeLog() {
  const log = useStore.getState().log;
  if (!log) return;
  useStore.setState({ log: null });
  send({ type: 'watch-log', sessionId: log.sessionId, taskId: null });
}

// Terminal colors and cursor moves would show as junk in plain text.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r(?!\n)/g, '');

const FOOT = {
  live: 'Live output from the CLI, last 8 KB · keeps streaming while it runs',
  file: 'Read from the output file the SDK reported',
  summary: 'No output to read; this is the task summary from the SDK',
};

// Header, streaming output and source line of one process log; shared by the popover and the focus view.
export function LogBody({ log, expand }: { log: ProcLogState; expand?: ReactNode }) {
  const proc = useStore((s) => s.panels[log.sessionId]?.procs.find((p) => p.id === log.taskId));
  const pre = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const now = useNow(proc?.state === 'running');

  useLayoutEffect(() => {
    if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [log.text]);

  return (
    <>
      <div className={`fh${proc?.label ? '' : ' mono'}`}>
        <span className="n" title={proc?.command}>{proc ? procName(proc) : log.taskId}</span>
        {proc && <span className={`st${proc.state === 'failed' ? ' fail' : ''}`}>{PROC_LABEL[proc.state]}</span>}
        {proc && <span className="end">{elapsed(proc, now)}</span>}
        {expand}
      </div>
      <Suspense fallback={<pre className="logbody mono" />}>
        <LogView
          text={stripAnsi(log.text)} cut={log.truncated} loading={log.source === null} name={proc ? procName(proc) : 'process'} scrollRef={pre}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
          }}
        />
      </Suspense>
      <div className="plog-foot">{log.source === 'redirect' ? `Read from ${log.path ?? 'the file'}, where the command writes its output · keeps updating while it runs` : log.source ? FOOT[log.source] : ' '}{log.truncated && ' · older output cut'}</div>
    </>
  );
}

function ProcLog() {
  const log = useStore((s) => s.log);
  const proc = useStore((s) => (s.log ? s.panels[s.log.sessionId]?.procs.find((p) => p.id === s.log!.taskId) : undefined));
  const ref = useRef<HTMLDivElement>(null);
  const isOpen = !!log && !log.inline;

  useEffect(() => {
    const el = ref.current!;
    // Handing the log to the focus view hides this popover but keeps the log streaming.
    const onToggle = (e: Event) => (e as ToggleEvent).newState === 'closed' && useFocus.getState().view?.mode !== 'log' && closeLog();
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, []);

  useEffect(() => {
    const el = ref.current!;
    if (isOpen && !el.matches(':popover-open') && useFocus.getState().view?.mode !== 'log') el.showPopover();
    else if (!isOpen && el.matches(':popover-open')) el.hidePopover();
  }, [isOpen]);

  const expand = (
    <button
      type="button" className="fx-btn" aria-label="Open the log full screen" title="Full screen"
      onClick={() => {
        if (!log) return;
        openLogView(log.taskId, ref.current!, proc ? procName(proc) : 'Process');
        ref.current!.hidePopover();
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7.5 1.5h3v3M10.5 1.5 7 5M4.5 10.5h-3v-3M1.5 10.5 5 7" /></svg>
    </button>
  );

  return (
    <div className="pop plog" popover="auto" ref={ref} aria-label="Process output">
      {log && !log.inline && <LogBody key={`${log.sessionId}:${log.taskId}`} log={log} expand={expand} />}
    </div>
  );
}

const SearchIcon = () => (
  <svg className="mg" width="13" height="13" viewBox="0 0 14 14"><circle cx="6" cy="6" r="4.3" /><path d="m9.3 9.3 3 3" /></svg>
);

export function Agents() {
  const sessionId = useStore((s) => s.current);
  const panel = useStore((s) => (s.current ? s.panels[s.current] : undefined));
  // Under 1024px the panel is a pill; unfolded there, it is a sheet over the conversation.
  const narrow = usePills();
  const [folded, setFolded] = useState(isPills);
  const [full, setFull] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  // Finished subagents and processes the user cleared away, per session; they come back with "Show".
  const [cleared, setCleared] = useState<Record<string, string[]>>({});
  const fromRef = useRef<DOMRect | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const foldRef = useRef<HTMLButtonElement>(null);
  // The height cap leaves room for the Work card, which sits on the composer (--ch).
  const panelEl = useLayoutVars(panelRef);

  const active = !!panel?.active || !!panel?.agents.length || !!panel?.procs.length;
  const allAgents = panel?.agents ?? [];
  const hidden = new Set(sessionId ? cleared[sessionId] ?? [] : []);
  const agents = allAgents.filter((a) => !hidden.has(a.id));
  const procs = (panel?.procs ?? []).filter((p) => !hidden.has(p.id));
  const finished = [...agents.filter((a) => !a.main && !live(a.state)), ...procs.filter((p) => p.state !== 'running')];
  const clearFinished = () => sessionId && setCleared({ ...cleared, [sessionId]: [...hidden, ...finished.map((a) => a.id)] });
  const showCleared = () => sessionId && setCleared({ ...cleared, [sessionId]: [] });
  // Only subagents light the count and LED; the main thread's turn and shell processes do not.
  // A workflow run is counted through its agents, but keeps the LED on before its first one starts.
  const runningCount = agents.filter((a) => !a.main && a.kind !== 'workflow' && live(a.state)).length;
  const busy = runningCount > 0 || agents.some((a) => a.kind === 'workflow' && live(a.state));
  // Folded pill: "2 running · 1 waiting · 1 failed · 5 done" (zero segments dropped) plus a peek at the lead live agent.
  const tally = { running: 0, waiting: 0, failed: 0, done: 0 };
  let peekAgent: AgentRow | undefined;
  for (const a of agents) {
    if (a.main || a.kind === 'workflow') continue;
    tally[a.state === 'stopped' ? 'done' : a.state]++;
    if (a.state === 'waiting') {
      if (peekAgent?.state !== 'waiting') peekAgent = a;
    } else if (a.state === 'running' && peekAgent?.state !== 'waiting' && (!peekAgent || a.startedAt > peekAgent.startedAt)) peekAgent = a;
  }
  const summary = (['running', 'waiting', 'failed', 'done'] as const).filter((k) => tally[k]).map((k) => `${tally[k]} ${k}`).join(' · ');
  const peek = peekAgent && `${peekAgent.name} · ${peekAgent.now || (peekAgent.state === 'waiting' ? 'Waiting for you' : 'Working')}`;
  const showPeek = !narrow && folded && !!peek;
  // Row clocks still tick for the main thread and running processes.
  const now = useNow(busy || procs.some((p) => p.state === 'running') || agents.some((a) => a.main && live(a.state)));
  const q = query.trim().toLowerCase();

  // Fade the list edges only where there is more to scroll.
  const fades = () => {
    const el = listRef.current;
    if (!el) return;
    el.classList.toggle('mt', el.scrollTop > 2);
    el.classList.toggle('mb', el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };

  const setSearch = (on: boolean) => {
    setSearching(on);
    if (on) setTimeout(() => inputRef.current?.focus(), 60);
    else setQuery('');
  };

  // Folded width hugs the title (CSS caps it at --pill-max): robot (16) or idle icon (14) + 8 gap + label + 8 gap + summary + 14px side padding.
  const hug = (busyNow: boolean) => {
    const panelEl = panelRef.current;
    const ttl = panelEl?.querySelector<HTMLElement>('.ttl');
    if (!panelEl || !ttl) return;
    const sumW = ttl.querySelector<HTMLElement>('.cnt .flaps')?.offsetWidth ?? 0;
    panelEl.style.setProperty('--mini', `${(busyNow ? 24 : 22) + ttl.querySelector('b')!.offsetWidth + (sumW ? 8 + sumW : 0) + 28}px`);
  };
  useLayoutEffect(() => {
    if (folded) hug(busy);
  }, [folded, busy, narrow]);
  // The summary's flap gains or drops cells after this render's layout effects, so its width is measured on resize.
  const flapsRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = flapsRef.current?.querySelector<HTMLElement>('.flaps');
    if (!folded || !el) return;
    const ro = new ResizeObserver(() => hug(busy));
    ro.observe(el);
    return () => ro.disconnect();
  }, [folded, busy, narrow]);

  const fullscreen = (v: boolean) => {
    fromRef.current = panelRef.current!.getBoundingClientRect();
    setFolded(false);
    setSearch(false);
    setFull(v);
    // The inline log belongs to the full view; leaving it stops the stream.
    if (!v && useStore.getState().log?.inline) closeLog();
  };
  useLayoutEffect(() => {
    const from = fromRef.current;
    fromRef.current = null;
    if (from) morphBox(panelRef.current!, from, full);
  }, [full]);
  useEscape(full, () => fullscreen(false));

  const fold = (f: boolean) => {
    if (f) hug(busy);
    setSearch(false);
    setFolded(f);
  };
  // Shrinking into the pill layout folds the panel so it never lands on the text, and widening undoes that fold.
  const autoFolded = useRef(folded);
  useLayoutEffect(() => {
    if (narrow) {
      if (!folded && !full) {
        autoFolded.current = true;
        fold(true);
      }
    } else if (autoFolded.current) {
      autoFolded.current = false;
      if (folded) fold(false);
    }
  }, [narrow]);
  useEscape(narrow && !folded && !full, () => fold(true));

  const toggleRow = (id: string) =>
    setOpenRows((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const rows = agents.filter((a) => {
    if (!q) return true;
    return a.files.some((f) => f.path.toLowerCase().includes(q)) || `${a.name} ${a.now} ${modelLine(a)}`.toLowerCase().includes(q);
  });

  // The main thread already shows in the conversation; the compact list keeps only subagents.
  const subRows = rows.filter((a) => !a.main);
  // A workflow's agents sit under its row; one whose run is hidden or filtered out shows on its own.
  const shownIds = new Set(subRows.map((a) => a.id));
  const kidsOf = new Map<string, AgentRow[]>();
  for (const a of subRows) {
    if (!a.parent || !shownIds.has(a.parent)) continue;
    const list = kidsOf.get(a.parent);
    if (list) list.push(a);
    else kidsOf.set(a.parent, [a]);
  }
  const topRows = subRows.filter((a) => !a.parent || !shownIds.has(a.parent));
  const agentRow = (a: AgentRow) => <Agent key={a.id} a={a} q={q} open={openRows.has(a.id)} onToggle={() => toggleRow(a.id)} now={now} sessionId={sessionId!} />;

  // Fades are re-checked when the list resizes or its rows change, never on the 1 s tick.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(fades);
    ro.observe(el);
    return () => ro.disconnect();
  }, [full, active, subRows.length, openRows, q]);

  return (
    <>
      <aside
        ref={panelEl}
        className={`panel rise${folded ? ' folded' : ''}${full ? ' full' : ''}${searching ? ' searching' : ''}${busy ? '' : ' idle'}${showPeek ? ' peeked' : ''}`}
        aria-label={folded ? 'Expand agents' : 'Agents'}
        role={folded ? 'button' : undefined}
        tabIndex={folded ? 0 : undefined}
        onClick={() => folded && fold(false)}
        onKeyDown={(e) => {
          if (folded && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            fold(false);
            setTimeout(() => foldRef.current?.focus());
          }
        }}
      >
        <div className="ph">
          <span className="ttl"><span className="pill-ic"><AgentsIcon /></span><span className="live">{busy && folded && <Robot size={GLYPH} state="calm" />}</span><b>Agents</b><span className={narrow ? 'cnt' : 'cnt sum'} ref={flapsRef}><Flap text={narrow ? String(runningCount) : summary} /></span></span>
          <span className="sp1"></span>
          <label className="srch">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeLinecap="round"><circle cx="6" cy="6" r="4.3" /><path d="m9.3 9.3 3 3" /></svg>
            <input
              ref={inputRef} placeholder="Search agents or files" autoComplete="off" aria-label="Search agents or files" value={query} tabIndex={searching ? 0 : -1}
              onChange={(e) => {
                setQuery(e.target.value);
                if (listRef.current) listRef.current.scrollTop = 0;
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                e.stopPropagation();
                setSearch(false);
              }}
            />
          </label>
          <button className="min sbtn" aria-label={searching ? 'Close search' : 'Search agents'} title={searching ? 'Close search' : 'Search agents or files'} onClick={() => setSearch(!searching)}>
            <SearchIcon />
            <svg className="x" width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
          </button>
          <button className="min expand" aria-pressed={full} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (esc)' : 'Full screen'} onClick={(e) => { e.stopPropagation(); fullscreen(!full); }}>
            <ExpandIcon out={full} />
          </button>
          <button ref={foldRef} className="min fold" aria-expanded={!folded} aria-label="Collapse agents" title="Collapse" onClick={(e) => { e.stopPropagation(); fold(true); }}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" /><path className="v" d="M5 1v8" /></svg>
          </button>
        </div>
        {!narrow && peek && <div className="pk" aria-hidden={!folded}><div><div className="sm-peek now"><span>{peek}</span></div></div></div>}
        <div className="body"><div>
          {full && sessionId && active ? (
            <AgentsFull agents={rows} procs={procs} now={now} sessionId={sessionId} sel={sel} onSel={setSel} />
          ) : (
          <div className="alist" ref={listRef} onScroll={fades}>
            {!active || !sessionId ? (
              <div className="empty">No agents yet. They show up here once the session starts working.</div>
            ) : subRows.length ? (
              topRows.map((a) => {
                const kids = kidsOf.get(a.id);
                if (!kids) return agentRow(a);
                kids.sort((x, y) => x.startedAt - y.startedAt);
                return [agentRow(a), <div key={`${a.id}:kids`} className="wf-kids" role="group" aria-label={`${a.name} agents`}>{kids.map(agentRow)}</div>];
              })
            ) : (
              <div className="empty">{q ? `No agent touched “${query.trim()}”` : 'No subagents yet. The main thread shows in the conversation.'}</div>
            )}
          </div>
          )}
          {sessionId && (finished.length > 0 || hidden.size > 0) && (
            <div className="aclean">
              {finished.length > 0 && <button className="btnx" onClick={clearFinished}>Clear {finished.length} finished</button>}
              {hidden.size > 0 && <button className="btnx" onClick={showCleared}>Show {hidden.size} cleared</button>}
            </div>
          )}
          {sessionId && !full && <Procs procs={procs} q={q} now={now} sessionId={sessionId} />}
        </div></div>
      </aside>
      <div className={`scrim${full ? ' on' : ''}`} aria-hidden="true" onClick={() => (full ? fullscreen(false) : fold(true))} />
      <ProcLog />
    </>
  );
}
