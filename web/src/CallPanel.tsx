import { lazy, Suspense, useEffect, useState } from 'react';
import type { CallActivity, CallUsage } from '../../server/protocol.ts';
import { useStore } from './store.ts';
import { AgentsIcon, Check, Chev, CopyBtn, tilde } from './bits.tsx';
import { useAmbient } from './perf.ts';
import { ChunkGuard } from './Stale.tsx';
import { closeCall, endCall, makeReport, setCallFull, toggleMute, undoCommand, useCall, type CallView } from './call.ts';

// The pieces the full screen (CallFull.tsx) and the side card's Call tab (CallTab.tsx) share.
const CallFull = lazy(() => import('./CallFull.tsx'));

export const HEAD: Record<CallView['state'], string> = {
  connecting: 'Connecting…', live: 'On call', reconnecting: 'Reconnecting…', ended: 'Call ended', error: 'Call failed',
};

// The status dot's tone and the words beside it.
export function callStatus(call: CallView) {
  const live = call.state === 'live' && !call.ending;
  const tone = call.ending || call.state === 'connecting' || call.state === 'reconnecting' ? 'connecting' : call.state;
  const text = call.ending ? 'Ending the call…' : HEAD[call.state];
  return { live, tone, text: live && call.muted ? `${text} · mic off` : text };
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Mounted only while the call is live, so its timer stops with it. Lite and reduced motion get whole minutes and a slow
// tick; a hidden tab skips ticks and catches up when it shows again.
export function Elapsed({ from }: { from: number }) {
  const calm = useAmbient();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) setNow(Date.now());
    };
    const t = setInterval(tick, calm ? 30_000 : 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [calm]);
  return <span className="cp-time">{calm ? `${Math.floor(Math.max(0, now - from) / 60_000)} min` : clock(now - from)}</span>;
}

function SavedPath({ path }: { path: string }) {
  const home = useStore((s) => s.home);
  return (
    <div className="rc-url">
      <span className="mono" title={path}>{tilde(path, home)}</span>
      <CopyBtn text={path} what="path" />
    </div>
  );
}

export const callDone = (call: CallView) => call.state === 'ended' || call.state === 'error';

// The error, and after the call what was saved and how the report goes.
export function Outcome({ call }: { call: CallView }) {
  const done = callDone(call);
  const r = call.report;
  return (
    <>
      {call.error && <p className="rc-sub bad" role="alert">{call.error}</p>}
      {done && call.file && !r && <><p className="rc-sub">Conversation saved.</p><SavedPath path={call.file} /></>}
      {r?.state === 'working' && <p className="rc-sub" role="status">Writing the report from the conversation…</p>}
      {r?.state === 'ready' && <><p className="rc-sub" role="status">Sent to chat: attached to {call.name}'s message box.</p><SavedPath path={r.file} /></>}
      {r?.state === 'failed' && <p className="rc-sub bad" role="alert">{r.error}</p>}
    </>
  );
}

// Mute and End during the call, Close and Generate report after it.
export function Actions({ call }: { call: CallView }) {
  const r = call.report;
  if (callDone(call)) {
    return (
      <div className="rc-acts cp-acts">
        <button type="button" className="rc-off" onClick={closeCall}>Close</button>
        {call.file && r?.state !== 'ready' && (
          <button type="button" className="rc-go cp-rep" disabled={r?.state === 'working'} aria-busy={r?.state === 'working'} onClick={makeReport}>
            {r?.state === 'working' ? <><span className="spin" aria-hidden="true" />Writing…</> : r?.state === 'failed' ? 'Try again' : 'Generate report'}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="rc-acts cp-acts">
      <button type="button" className="rc-off cp-mute" aria-pressed={call.muted} disabled={call.ending || call.state === 'connecting'} onClick={toggleMute}>
        {call.muted ? 'Unmute' : 'Mute'}
      </button>
      <button type="button" className="cp-end" disabled={call.ending} onClick={endCall}>End</button>
    </div>
  );
}

const glyph = (d: string) => () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const SendIcon = glyph('M2.2 7h8.6M7.4 3.4 11 7l-3.6 3.6');
// What the voice asked the agent behind it.
const AskIcon = glyph('M2.5 3h9v6.2H6.6L4 11.3V9.2H2.5z');

type Entry = { a: CallActivity; steps: CallActivity[] };

// A request heads the steps after it. Agents and actions stand on their own, so a step that comes after one still
// lands under its request.
function entries(acts: CallActivity[]) {
  const out: Entry[] = [];
  let req: Entry | null = null;
  for (const a of acts) {
    if (a.kind === 'step' && req) {
      req.steps.push(a);
      continue;
    }
    const e: Entry = { a, steps: [] };
    out.push(e);
    if (a.kind === 'request') req = e;
  }
  return out;
}

// Only a running step breathes; a running agent holds still in the accent colour.
function Mark({ a }: { a: CallActivity }) {
  if (a.state === 'failed') return <i className="vc-mk" aria-hidden="true">✕</i>;
  if (a.kind === 'agent') return <i className="vc-mk" aria-hidden="true"><AgentsIcon /></i>;
  if (a.kind === 'command') return <i className="vc-mk" aria-hidden="true"><SendIcon /></i>;
  return <i className="vc-mk" aria-hidden="true">{a.state === 'running' ? <b className="vc-pulse" /> : <Check />}</i>;
}

// A held command: the seconds left and the Undo button. The timer also stops at the deadline, in case the row never leaves running (socket lost).
function Hold({ id, until }: { id: string; until: number }) {
  const [now, setNow] = useState(Date.now);
  const over = now >= until;
  useEffect(() => {
    if (over) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [over]);
  if (over) return null;
  return (
    <>
      <span className="vc-left">{Math.max(0, Math.ceil((until - now) / 1000))}s</span>
      <button type="button" className="vc-undo" onClick={() => undoCommand(id)}>Undo</button>
    </>
  );
}

function Row({ a }: { a: CallActivity }) {
  return (
    <li className="vc-row" data-kind={a.kind} data-state={a.state} title={a.title}>
      <Mark a={a} />
      <span>{a.text}{a.state !== 'done' && <span className="sr"> ({a.state})</span>}</span>
      {a.until !== undefined && a.state === 'running' && <Hold id={a.id} until={a.until} />}
    </li>
  );
}

const REQUEST_END = { done: 'Answered', failed: 'Failed' };

// limit keeps the newest steps and says how many came before.
function Request({ e, limit }: { e: Entry; limit: number }) {
  const { a } = e;
  const steps = limit ? e.steps.slice(-limit) : e.steps;
  const earlier = e.steps.length - steps.length;
  // The request's own pulse covers the wait before its first step, and steps between.
  const quiet = a.state === 'running' && !e.steps.some((s) => s.state === 'running');
  return (
    <li className="vc-g" data-state={a.state}>
      <div className="vc-req" title={a.title}>
        <i className="vc-mk" aria-hidden="true"><AskIcon /></i>
        <span className="vc-req-t">{a.text}</span>
        <span className="vc-end">
          {a.state === 'running' ? <>{quiet && <b className="vc-pulse" />}Working</> : <>{a.state === 'done' && <Check />}{REQUEST_END[a.state]}</>}
        </span>
      </div>
      {a.usage && (
        <p className="vc-cost">
          {tok(a.usage.input)} in ({tok(a.usage.cached)} cached) · {tok(a.usage.output)} out{a.usage.ms !== null && ` · ${Math.round(a.usage.ms / 1000)} s`}
        </p>
      )}
      {steps.length > 0 && (
        <ol className="vc-steps">
          {earlier > 0 && <li className="vc-earlier">{earlier} earlier {earlier === 1 ? 'step' : 'steps'}</li>}
          {steps.map((s) => <Row key={s.id} a={s} />)}
        </ol>
      )}
    </li>
  );
}

// The Call tab shows this many of the newest entries, each with this many of its newest steps.
const COMPACT_ENTRIES = 2;
const COMPACT_STEPS = 3;

export function Feed({ acts, compact = false }: { acts: CallActivity[]; compact?: boolean }) {
  if (!acts.length) {
    return <p className="vc-empty">{compact ? 'Nothing yet.' : 'Nothing yet. Ask Codex to look into something, start an agent or send the session a message, and its steps show here.'}</p>;
  }
  const all = entries(acts);
  const shown = compact ? all.slice(-COMPACT_ENTRIES) : all;
  const hidden = all.length - shown.length;
  // column-reverse keeps the newest row in view at the bottom while the reader stays there, with no scroll code.
  return (
    <ol className={`vc-feed${compact ? ' compact' : ''}`} aria-label="What Codex is doing">
      {shown.toReversed().map((e) => (e.a.kind === 'request' ? <Request key={e.a.id} e={e} limit={compact ? COMPACT_STEPS : 0} /> : <Row key={e.a.id} a={e.a} />))}
      {hidden > 0 && (
        <li className="vc-earlier">
          <button type="button" onClick={() => setCallFull(true)}>{hidden} earlier · see all in full screen</button>
        </li>
      )}
    </ol>
  );
}

const tok = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pct = (n: number) => `${+n.toFixed(1)}%`;

// On demand, so it stays out of the way: the agent behind the voice's tokens, and the Codex limit since the call began.
export function Usage({ usage }: { usage: CallUsage | null }) {
  if (!usage) return null;
  const { agentInput, agentCached, agentOutput, limitAtStart, limitNow, credits, usd } = usage;
  return (
    <details className="cu">
      <summary>Usage<Chev /></summary>
      <dl>
        <dt>Agent tokens</dt>
        <dd>{tok(agentInput)} in ({tok(agentCached)} cached) · {tok(agentOutput)} out</dd>
        {credits !== null && <><dt>Codex estimate</dt><dd>{+credits.toFixed(2)} credits{usd !== null && ` · US$ ${usd.toFixed(2)}`}</dd></>}
        {limitAtStart !== null && limitNow !== null && <><dt>Codex limit</dt><dd>{pct(limitAtStart)} → {pct(limitNow)}</dd></>}
      </dl>
    </details>
  );
}

// The full screen stays mounted for the whole call view; minimized, the side card's Call tab (CallTab.tsx) shows the call.
export default function CallHost() {
  const call = useCall();
  return call && <ChunkGuard><Suspense fallback={null}><CallFull call={call} /></Suspense></ChunkGuard>;
}
