import { useEffect, useState } from 'react';
import type { HandoffPhase, Toast } from '../../server/protocol.ts';
import { currentSummary, useStore } from './store.ts';
import { send } from './socket.ts';
import { Check, useTicker, XIcon } from './bits.tsx';
import { dur } from './Working.tsx';
import { openText } from './Focus.tsx';
import { handoffLive, type HandoffNote } from './handoff.ts';
import { Robot, type RobotState } from './robot.tsx';
import type { LedPattern } from './led.tsx';
import { Flap } from './flap.tsx';

const tok = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const STEPS: [HandoffPhase, string][] = [['writing', 'Writing handoff'], ['compacting', 'Compacting'], ['handing', 'Handing over']];
// A finished card stays a moment so the result reads; a failed one a little longer.
const LINGER = { done: 8000, failed: 20000 };
// The card's robot: folds into its wheel while the handoff runs, re-stacks on hand-over, then reacts to the result.
const BOT: Record<HandoffPhase, [RobotState, LedPattern?]> = {
  writing: ['handoff', 'edit'], compacting: ['handoff', 'think'], handing: ['restack'], done: ['done'], failed: ['error'],
};

// Each step mounts its own live row, so the label starts blank and flips in.
function LiveStep({ text }: { text: string }) {
  const [shown, setShown] = useState('');
  useEffect(() => setShown(text), [text]);
  return (
    <>
      <i className="ic now" aria-hidden="true"></i>
      <Flap text={shown} className="lbl mono" />
    </>
  );
}

// The live handoff at the bottom of the conversation: three steps, elapsed time and the context before and after.
export function HandoffCard() {
  const h = useStore((s) => (s.current ? s.maps[s.current]?.handoff ?? null : null));
  const sessionId = useStore((s) => s.current);
  const busy = useStore((s) => {
    const r = currentSummary(s);
    return !!r && (r.state === 'working' || r.state === 'waiting');
  });
  const live = handoffLive(h);
  const tick = useTicker(live, 1000);
  // Render reads time from state only; the React Compiler would cache a bare Date.now().
  const [later, setLater] = useState(0);
  // The endedAt of the failed run already retried, so a double click sends once.
  const [retried, setRetried] = useState<number | null>(null);
  const now = Math.max(tick, later);
  // Hides the finished card once its linger ends; no ticking while it waits.
  useEffect(() => {
    if (!h?.endedAt || live) return;
    const left = h.endedAt + LINGER[h.phase as 'done' | 'failed'] - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setLater(Date.now()), left + 50);
    return () => clearTimeout(t);
  }, [h?.endedAt, h?.phase, live]);
  if (!h) return null;
  if (!live && (!h.endedAt || now - h.endedAt > LINGER[h.phase as 'done' | 'failed'])) return null;

  const at = STEPS.findIndex(([p]) => p === h.phase);
  const end = h.endedAt ?? now;
  const tokens = h.pre === null ? null : h.post !== null ? `${tok(h.pre)} → ${tok(h.post)}` : `${tok(h.pre)} tokens`;
  const stepMs = (i: number) => {
    const from = h.steps[STEPS[i][0]];
    if (from === undefined) return null;
    const to = h.steps[STEPS[i + 1]?.[0]] ?? h.endedAt ?? now;
    return to - from;
  };
  const failedAt = h.phase === 'failed' ? STEPS.reduce((k, [p], i) => (h.steps[p] !== undefined ? i : k), 0) : -1;
  const [bot, led] = BOT[h.phase];
  return (
    <div className={`hof ${h.phase}`} role="status" aria-label={`Context handoff: ${h.phase}`}>
      <Robot size={52} state={bot} led={led} lead />
      <div className="hof-body">
        <div className="hof-top">
          <b>{h.phase === 'done' ? 'Context handed off' : h.phase === 'failed' ? 'Handoff failed' : 'Context handoff'}</b>
          {tokens && <span className="tk mono">{tokens}</span>}
          <span className="st mono">{dur(end - h.startedAt)}</span>
        </div>
        <ol className="hof-steps">
          {STEPS.map(([p, label], i) => {
            const state = h.phase === 'done' || i < at || (failedAt >= 0 && i < failedAt) ? 'done' : i === at ? 'now' : i === failedAt ? 'bad' : 'todo';
            const ms = state === 'todo' ? null : stepMs(i);
            return (
              <li key={p} className={state}>
                {state === 'now' ? <LiveStep text={label} /> : (
                  <>
                    <i className="ic" aria-hidden="true">{state === 'done' ? <Check /> : state === 'bad' ? <XIcon /> : null}</i>
                    <span className="lbl mono">{label}</span>
                  </>
                )}
                {ms !== null && <small className="mono">{dur(ms)}</small>}
              </li>
            );
          })}
        </ol>
        {h.error && <p className="hof-err">{h.error}{h.path ? ` · the handoff is kept at ${h.path}` : ''}. It retries after the next reply.</p>}
        {h.phase === 'failed' && sessionId && (
          <div className="hof-act">
            <button
              type="button" className="hof-retry" disabled={busy || retried === h.endedAt}
              onClick={() => {
                setRetried(h.endedAt);
                send({ type: 'handoff', sessionId });
              }}
            >
              Try again
            </button>
            {busy && <small>Available once it finishes</small>}
          </div>
        )}
        {h.held.length > 0 && (
          <p className="hof-held">
            {live ? `${h.held.length === 1 ? 'Your message waits' : `${h.held.length} messages wait`} and sends after the handoff` : 'Sent your waiting message'}
            <span className="mono"> · {h.held[h.held.length - 1]}</span>
          </p>
        )}
      </div>
    </div>
  );
}

const DocIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 1.8h5.2L12.5 5v9.2H4z" /><path d="M9 1.8V5h3.5M6 8h4.5M6 10.5h4.5" strokeLinecap="round" />
  </svg>
);

// The hand-over message (or a compaction summary) in the conversation, opening in the reader.
export function NoteCard({ id, note }: { id: string; note: HandoffNote }) {
  const label = note.kind === 'handoff' ? 'Handoff' : 'Compaction summary';
  return (
    <div className="hon" data-id={id}>
      <span className="hon-ic"><DocIcon /></span>
      <div className="hon-txt">
        <span className="hon-t"><b>{label}</b><span>{note.title}</span></span>
        {note.path && <small className="mono" title={note.path}>{note.path}</small>}
      </div>
      <button type="button" className="hon-open" onClick={(e) => openText({ paste: note.body, md: true, label }, e.currentTarget.closest('.hon') ?? e.currentTarget)}>
        Read
      </button>
    </div>
  );
}

// Mods' toasts for the session on screen; each leaves at its own time or on ×.
export function Toasts() {
  const toasts = useStore((s) => (s.current ? s.maps[s.current]?.toasts : undefined));
  const [closed, setClosed] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const shown = (toasts ?? []).filter((t: Toast) => t.until > now && !closed.includes(t.id));
  const next = shown.length ? Math.min(...shown.map((t) => t.until)) : null;
  useEffect(() => {
    if (next === null) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [next]);
  if (!shown.length) return null;
  return (
    <div className="toasts" role="status">
      {shown.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.text}</span>
          <button type="button" aria-label="Dismiss" title="Dismiss" onClick={() => setClosed((c) => [...c, t.id])}><XIcon /></button>
        </div>
      ))}
    </div>
  );
}
