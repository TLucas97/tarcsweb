import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AgentRow, AgentText, FileTouch, WatchEntry } from '../../server/protocol.ts';
import { cardsOf, currentSummary, useStore } from './store.ts';
import { send } from './socket.ts';
import { Markdown } from './Markdown.tsx';
import { SendTextBtn } from './SendToChat.tsx';
import { Card as ChangeCardBtn } from './Changes.tsx';
import { useAutosize } from './autosize.ts';
import { Led, activityOf as patternOf } from './led.tsx';
import { openFile } from './FileTree.tsx';
import { Check, tickText, tilde } from './bits.tsx';
import { activityOf, askActivity, cleanLog, dur, useActivity } from './agentActivity.ts';

// One agent run read as a chat: the prompt it got, what it said, its tool calls, the report, and a follow-up box.
const live = (s: string) => s === 'running' || s === 'waiting';
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// Texts compare without their whitespace, which differs between a message, its report and a forwarded copy.
const squash = (s: string) => s.replace(/\s+/g, '');
const FILE_VERBS = new Set(['read', 'edit', 'write']);
const outTail = (s: string) => cleanLog(s).replace(/\n+$/, '').split('\n').slice(-6).join('\n');
// A prompt past this many characters or lines starts folded; both stay taller than the fold's 220px.
const PROMPT_FOLD = 1200;
const PROMPT_LINES = 12;
// A finished run of tool calls longer than FOLD shows its last SHOW calls until opened.
const FOLD = 10;
const SHOW = 6;
// Sent messages shown before the agent's follow-up list confirms them; the server keeps a follow-up's first FOLLOW_CHARS.
const PENDING_MAX = 5;
const FOLLOW_CHARS = 4000;
// Confirming follow-ups remembered; the server keeps only its newest 20 follow-ups anyway.
const USED_MAX = 20;
// Trailing messages tried as the report's source, newest first.
const REPORT_PARTS = 6;

type Follow = { at: number; text: string };
// after: the newest follow-up known when it was sent, so only a newer one confirms it.
type Pending = Follow & { after: number };
// faint: only the first sentence is known; capped: the body stops at the server's cap.
type Msg = { k: 'say'; key: string; text: string; faint: boolean; capped: boolean; streaming?: boolean; report?: boolean };
type Item = Msg | { k: 'steps'; key: string; list: WatchEntry[] } | { k: 'follow'; key: string; f: Follow; note?: string };

// Loads when the view opens, refreshes once a second while the agent runs, and stops when it closes.
function useRunActivity(sessionId: string, a: AgentRow, on: boolean) {
  const running = live(a.state);
  const act = useActivity((s) => (on ? activityOf(s, sessionId, a.id) : undefined));
  useEffect(() => {
    if (!on) return;
    askActivity(send, sessionId, a.id);
    if (!running) return;
    const t = setInterval(() => !document.hidden && askActivity(send, sessionId, a.id), 1000);
    return () => clearInterval(t);
  }, [on, sessionId, a.id, running]);
  return act;
}

// Texts become messages keyed by the message they belong to, so a streamed one keeps its subtree once saved.
// Runs of tool calls form one group, and follow-ups land where their time puts them.
function itemsOf(entries: WatchEntry[], follows: Follow[]) {
  const out: Item[] = [];
  const keys = new Set<string>();
  let fi = 0;
  const flush = (upTo: number) => {
    for (; fi < follows.length && follows[fi].at <= upTo; fi++) out.push({ k: 'follow', key: `f:${follows[fi].at}`, f: follows[fi] });
  };
  for (const e of entries) {
    if (e.at !== null) flush(e.at);
    if (e.k === 'text') {
      // A message with several text blocks keys its later ones by entry.
      const key = e.mid && !keys.has(`m:${e.mid}`) ? `m:${e.mid}` : `m:${e.id}`;
      keys.add(key);
      out.push({ k: 'say', key, text: e.t ?? e.s ?? '', faint: e.t === undefined, capped: !!e.cut });
      continue;
    }
    const last = out.at(-1);
    if (last?.k === 'steps') last.list.push(e);
    else out.push({ k: 'steps', key: `s:${e.id}`, list: [e] });
  }
  flush(Infinity);
  return out;
}

// The last messages that make up the report, [start, end): follow-ups sent during the reply may sit after them.
// Whole bodies must equal it; a capped last one only has to begin it.
function reportSpan(items: Item[], report: string): [number, number] | null {
  let end = items.length;
  while (end > 0 && items[end - 1].k === 'follow') end--;
  const last = items[end - 1];
  if (last?.k !== 'say') return null;
  const r = squash(report);
  let body = '';
  for (let i = end - 1; i >= 0 && i >= end - REPORT_PARTS; i--) {
    const x = items[i];
    if (x.k !== 'say' || x.faint) return null;
    body = squash(x.text) + body;
    if (last.capped ? r.startsWith(body) : body === r) return [i, end];
  }
  return null;
}

const ChevSmall = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

// One message; the same element and Markdown slot serve it while streaming, once saved and as the report.
const Say = memo(function Say({ text, faint, capped, streaming, report, name, anchor }: {
  text: string; faint: boolean; capped: boolean; streaming?: boolean; report?: boolean; name: string; anchor?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={anchor} className={`ac-say${faint ? ' faint' : ''}${report ? ' ac-rep' : ''}`} role={report ? 'region' : undefined} aria-label={report ? 'Report' : undefined}>
      {report ? <h4>Report<SendTextBtn text={() => `Report from the agent "${name}":\n\n${text}`} what="the agent's report" /></h4> : null}
      <Markdown text={capped ? `${text}…` : text} live={streaming} />
    </div>
  );
});

function Prompt({ text, who, name }: { text: string; who: string; name: string }) {
  const long = text.length > PROMPT_FOLD || text.split('\n', PROMPT_LINES + 1).length > PROMPT_LINES;
  const [all, setAll] = useState(false);
  return (
    <div className="ac-me">
      <div className="ac-who">{who}<SendTextBtn text={() => `Task given to the agent "${name}":\n\n${text}`} what="the agent's prompt" /></div>
      <div className={`ac-mb${long && !all ? ' clamp' : ''}`}><Markdown text={text} /></div>
      {long && <button type="button" className="btnx ac-all" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show less' : 'Show all'}</button>}
    </div>
  );
}

function FollowUp({ f, note }: { f: Follow; note?: string }) {
  return (
    <div className={`ac-me fu${note ? ' pend' : ''}`}>
      <div className="ac-who">{note ?? 'Follow-up'}<time dateTime={new Date(f.at).toISOString()}>{hhmm(f.at)}</time></div>
      <div className="ac-mb plain">{f.text}</div>
    </div>
  );
}

// One tool call on one line; the ones with more to say open in place.
const Step = memo(function Step({ e, running }: { e: WatchEntry; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (e.k === 'note') {
    return <li className="ac-step note"><div className="ac-row"><span className="ac-v">step</span><span className="ac-s">{e.n ? `${e.d ?? 0}/${e.n} · ` : ''}{e.s}</span></div></li>;
  }
  const s = e.s ?? '';
  // Paths outside the session folder (~/…) are not in the file tree.
  const file = e.k === 'tool' && FILE_VERBS.has(e.verb ?? '') && !!s && !s.startsWith('~');
  const busy = running && e.end === undefined && (e.k === 'tool' || e.k === 'agent');
  const exit = e.exit !== undefined && e.exit !== 0 ? e.exit : null;
  const bad = !!e.err || exit !== null || e.k === 'error';
  const took = e.end !== undefined && e.at !== null ? e.end - e.at : null;
  const wide = !!e.desc || s.length > 60;
  const more = wide || !!e.why || !!e.out || file;
  const line = (
    <>
      <span className="ac-v">{e.k === 'error' ? 'error' : e.verb ?? e.k}</span>
      <span className={`ac-s${e.verb === 'run' && !e.desc ? ' mono' : ''}`}>{e.desc || s}</span>
      {e.add !== undefined && <span className="ac-n"><span className="add">+{e.add}</span> <span className="rm">−{e.rm ?? 0}</span></span>}
      {busy && <span className="ac-st">running</span>}
      {exit !== null ? <span className="ac-st bad">exit {exit}</span> : e.err && <span className="ac-st bad">failed</span>}
      {more && <ChevSmall />}
    </>
  );
  return (
    <li className={`ac-step${bad ? ' bad' : ''}`}>
      {more ? <button type="button" className="ac-row" aria-expanded={open} onClick={() => setOpen(!open)}>{line}</button> : <div className="ac-row">{line}</div>}
      {open && (
        <div className="ac-det">
          {wide && <div className={`ac-full${e.verb === 'run' || file ? ' mono' : ''}`}>{s}</div>}
          {e.why && <div className="ac-why">{e.why}</div>}
          {e.out && <pre className="ac-out mono">{outTail(e.out)}</pre>}
          {(took !== null || file) && (
            <div className="ac-dm">
              {took !== null && <span>{took < 1000 ? 'took under 1s' : `took ${dur(took)}`}</span>}
              {file && <button type="button" className="btnx" onClick={(ev) => openFile(s, undefined, ev.currentTarget)}>Open file</button>}
            </div>
          )}
        </div>
      )}
    </li>
  );
});

function Steps({ list, running, fold }: { list: WatchEntry[]; running: boolean; fold: boolean }) {
  const [all, setAll] = useState(false);
  const hide = fold && !all && list.length > FOLD ? list.length - SHOW : 0;
  return (
    <ul className="ac-steps" aria-label={`${list.length} tool call${list.length > 1 ? 's' : ''}`}>
      {hide > 0 && <li><button type="button" className="btnx ac-more" onClick={() => setAll(true)}>{hide} earlier tool calls</button></li>}
      {(hide ? list.slice(hide) : list).map((e) => <Step key={e.id} e={e} running={running} />)}
    </ul>
  );
}

// This agent's diff cards from every turn, each opening the full diff.
function AgentChanges({ owner, sessionId }: { owner: string; sessionId: string }) {
  const all = useStore((s) => cardsOf(s, owner));
  const pairs = all.filter(([, c]) => c.files.length);
  if (!pairs.length) return null;
  return (
    <div className="dv-strip">
      {pairs.map(([id, c]) => <ChangeCardBtn key={c.id} c={c} item={id} sessionId={sessionId} last={false} />)}
    </div>
  );
}

const roughAgo = (ms: number) => (ms < 5000 ? 'now' : dur(ms));

// One row per file, relative to the session folder; the folder part gives way first so the name stays readable.
function AgentFiles({ files, more }: { files: FileTouch[]; more: number }) {
  const cwd = useStore((s) => currentSummary(s)?.cwd?.replace(/\/+$/, '') ?? '');
  const home = useStore((s) => s.home);
  return (
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
            <span className="ad-fa" ref={tickText((now) => roughAgo(now - f.at), true)}></span>
          </li>
        );
      })}
      {more > 0 && <li className="ad-f"><span>+{more} more</span></li>}
    </ul>
  );
}

// The files it touched, folded to one line that names what it edited.
function Touched({ a, sessionId }: { a: AgentRow; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const files = a.files;
  if (!files.length) return null;
  const more = a.filesMore ?? 0;
  const edited = files.filter((f) => f.mode === 'edited');
  const names = edited.slice(0, 3).map((f) => f.path.split('/').pop()).join(', ');
  const n = files.length + more;
  return (
    <div className="ac-files">
      <button type="button" className="ac-row ac-fsum" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ac-v">files</span>
        <span className="ac-s">
          {n} file{n > 1 ? 's' : ''} · {edited.length ? `edited ${names}${edited.length > 3 ? ` and ${edited.length - 3} more` : ''}` : 'read only'}
        </span>
        <ChevSmall />
      </button>
      {open && (
        <div className="ac-det">
          <AgentChanges owner={a.id} sessionId={sessionId} />
          <AgentFiles files={files} more={more} />
        </div>
      )}
    </div>
  );
}

const STATE_SAID: Record<AgentRow['state'], string> = { running: 'Working', waiting: 'Needs you', done: 'Finished', failed: 'Failed', stopped: 'Stopped' };

// Where the run stands, at the end of the chat. Only a working run animates, and only this LED.
function Tail({ a }: { a: AgentRow }) {
  const ran = a.durationMs ?? (a.endedAt !== null ? a.endedAt - a.startedAt : null);
  const calls = a.toolUses ? ` · ${a.toolUses} tool call${a.toolUses > 1 ? 's' : ''}` : '';
  const s = a.steps;
  return (
    <div className={`ac-tail ${a.state}`}>
      <span className="sr" role="status">{STATE_SAID[a.state]}</span>
      {a.state === 'running' ? (
        <>
          <Led size="sm" pattern={patternOf(a.now)} />
          <span className="ac-tl">{a.now || 'Working'}</span>
          {s && <span className="ac-tn">{s.done}/{s.total}</span>}
          {a.summary && <small className="ac-ts">{a.summary}</small>}
        </>
      ) : a.state === 'waiting' ? (
        <><span className="ac-dot" aria-hidden="true"></span><span className="ac-tl">Needs you: its request is waiting in the chat</span></>
      ) : a.state === 'done' ? (
        <><Check /><span className="ac-tl">Finished{ran !== null ? ` in ${dur(ran)}` : ''}{calls}</span></>
      ) : a.state === 'failed' ? (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          <span className="ac-tl">Failed{ran !== null ? ` after ${dur(ran)}` : ''}{a.error ? `: ${a.error}` : ''}</span>
        </>
      ) : (
        <>
          <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x=".5" y=".5" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
          <span className="ac-tl">Stopped{ran !== null ? ` after ${dur(ran)}` : ''}</span>
        </>
      )}
    </div>
  );
}

// What happens to a message depends on who runs the agent; the note says so before sending.
function routeNote(a: AgentRow, running: boolean) {
  if (a.relay) return 'Goes to the main agent, which is asked to pass it on with SendMessage.';
  if (a.kind === 'codex') return running ? 'Codex reads it during its current turn.' : 'Codex starts a new turn with it.';
  return running ? 'Claude reads it after its current step.' : 'Claude starts a new turn with it.';
}

function Composer({ a, sessionId, onSent }: { a: AgentRow; sessionId: string; onSent: (text: string) => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  useAutosize(area, text);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (!send({ type: 'agent-message', sessionId, agentId: a.id, text: t })) return setErr('Not connected. Your message is still here; try again.');
    setText('');
    setErr('');
    onSent(t);
  };
  return (
    <form className="ac-in" onSubmit={(e) => (e.preventDefault(), submit())}>
      <textarea
        ref={area} rows={1} value={text} placeholder={`Message ${a.name}`} aria-label={`Message ${a.name}`} aria-describedby="ac-route"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
          if (e.key === 'Escape') (e.stopPropagation(), e.currentTarget.blur());
        }}
      />
      <button type="submit" className="btnx" disabled={!text.trim()}>Send</button>
      <small id="ac-route" className={err ? 'ac-err' : undefined}>{err || routeNote(a, live(a.state))}</small>
    </form>
  );
}

export default function AgentChat({ a, sessionId, t }: { a: AgentRow; sessionId: string; t: AgentText | undefined }) {
  const running = live(a.state);
  // Agent tool subagents (relay) and Codex runs have activity; workflow agents, runs a Codex main started and the main row do not.
  const hasAct = a.kind === 'codex' || (a.kind === 'claude' && !!a.relay && !a.parent);
  const act = useRunActivity(sessionId, a, hasAct);
  // Sent messages not confirmed yet, and the follow-ups (by time) that already confirmed one, so none confirms twice.
  const [sends, setSends] = useState<{ pending: Pending[]; used: number[] }>({ pending: [], used: [] });
  const scroller = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  // Follows new content while the reader sits at the bottom; a finished run opens on its report instead.
  const stick = useRef(running);

  let report = t?.result?.trim() || null;
  // A Codex run that failed before answering reports its error, which the tail already shows.
  if (report && a.error && squash(report) === squash(a.error)) report = null;
  const follows = t?.followUps ?? [];
  const loaded = !!t && (!hasAct || !!act?.loaded);
  let items: Item[] = [];
  if (hasAct) {
    const lv = t?.live;
    // The saved copy of the newest message takes its first chunk's time (a message's place is when it began),
    // and the live body when the saved one stops at its cap, so blocks past the cut stay.
    const entries = (act?.entries ?? [])
      .filter((e) => e.k !== 'user' && e.k !== 'turn-end' && e.k !== 'plan')
      .map((e) => {
        if (!lv || e.mid !== lv.id) return e;
        const richer = (e.cut || e.t === undefined) && lv.text.trim().length > (e.t?.length ?? 0);
        return { ...e, at: e.at === null ? null : Math.min(e.at, lv.at), ...(richer ? { t: lv.text.trim(), cut: lv.cut } : {}) };
      });
    // The message still streaming, or cut off by a stop, until an entry for it is saved.
    const unsaved = lv && lv.text.trim() && !entries.some((e) => e.mid === lv.id) ? lv : null;
    if (unsaved) entries.push({ k: 'text', id: `live:${unsaved.id}`, mid: unsaved.id, at: unsaved.at, t: unsaved.text.trim(), ...(unsaved.cut ? { cut: true as const } : {}) });
    items = itemsOf(entries, follows);
    const streamed = unsaved && running ? items.find((x) => x.k === 'say' && x.key === `m:${unsaved.id}`) : undefined;
    if (streamed?.k === 'say') streamed.streaming = true;
    // The report usually repeats the last message; that message turns into the report and keeps its key.
    const span = report && !running ? reportSpan(items, report) : null;
    if (report && span) items.splice(span[0], span[1] - span[0], { ...(items[span[0]] as Msg), text: report, capped: false, report: true });
    else if (report) items.push({ k: 'say', key: 'report', text: report, faint: false, capped: false, report: true });
  } else {
    // Runs without activity have only their follow-ups and output, which the report replaces once it lands.
    items = itemsOf([], follows);
    const text = report ?? t?.text.trim() ?? '';
    if (text) items.push({ k: 'say', key: 'out', text, faint: false, capped: false, report: !!report, streaming: running && !report });
  }

  // Each sent message is confirmed by its own follow-up: newer than any known when it was sent, with the same text.
  const used = new Set(sends.used);
  const acked = new Map<Pending, number>();
  for (const p of sends.pending) {
    const want = squash(p.text.slice(0, FOLLOW_CHARS));
    const f = follows.find((x) => !used.has(x.at) && x.at > p.after && squash(x.text) === want);
    if (!f) continue;
    used.add(f.at);
    acked.set(p, f.at);
  }
  useEffect(() => {
    if (!acked.size) return;
    setSends((s) => ({ pending: s.pending.filter((p) => !acked.has(p)), used: [...s.used, ...acked.values()].slice(-USED_MAX) }));
  }, [acked.size, follows]);
  for (const p of sends.pending) {
    if (!acked.has(p)) items.push({ k: 'follow', key: `p:${p.at}`, f: p, note: a.relay ? 'Sent to the main agent to pass on' : 'Sent' });
  }
  const lastSteps = items.findLast((x) => x.k === 'steps');
  const who = a.parent || a.kind === 'workflow' ? 'Prompt' : 'Prompt from the main agent';

  // Opens on the report when there is one, else at the newest line.
  useEffect(() => {
    if (!loaded) return;
    const id = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      const rep = reportRef.current;
      el.scrollTop = !running && rep ? Math.max(0, rep.offsetTop - 12) : el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [loaded]);

  // A run that ends while followed jumps to its report's start, not its last line; set before the observer runs.
  const settled = !running && !!report;
  useLayoutEffect(() => {
    if (!settled || !stick.current) return;
    stick.current = false;
    const id = requestAnimationFrame(() => {
      const el = scroller.current;
      const rep = reportRef.current;
      if (el && rep) el.scrollTop = Math.max(0, rep.offsetTop - 12);
    });
    return () => cancelAnimationFrame(id);
  }, [settled]);

  useEffect(() => {
    const c = col.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      const el = scroller.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const sent = (text: string) => {
    const after = follows.at(-1)?.at ?? 0;
    setSends((s) => ({ ...s, pending: [...s.pending.slice(-(PENDING_MAX - 1)), { at: Date.now(), text, after }] }));
    stick.current = true;
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  return (
    <div className="ac">
      <div
        className="ac-scroll" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
        }}
      >
        <div className="ac-col" ref={col}>
          {t?.task && <Prompt text={t.task} who={who} name={a.name} />}
          {!!act?.more && <p className="ac-gap">{act.more} earlier steps are not kept here</p>}
          {items.map((x) =>
            x.k === 'say' ? (
              <Say
                key={x.key} text={x.text} faint={x.faint} capped={x.capped} streaming={x.streaming} report={x.report} name={a.name}
                anchor={x.report ? reportRef : undefined}
              />
            ) : x.k === 'follow' ? <FollowUp key={x.key} f={x.f} note={x.note} />
              : <Steps key={x.key} list={x.list} running={running} fold={!(running && x === lastSteps)} />,
          )}
          {loaded && !running && !items.length && <p className="ac-empty">Nothing recorded for this run.</p>}
          {loaded && running && !items.length && (
            <p className="ac-empty">{a.now ? 'Steps show here as the agent records them.' : "Waiting for the agent's first step."}</p>
          )}
          <Touched a={a} sessionId={sessionId} />
          <Tail a={a} />
        </div>
      </div>
      {a.canMessage ? (
        <Composer a={a} sessionId={sessionId} onSent={sent} />
      ) : (
        <p className="ac-in ac-off">{a.parent || a.kind === 'workflow' ? 'Workflow agents do not take messages.' : 'Messages cannot reach this agent now.'}</p>
      )}
    </div>
  );
}
