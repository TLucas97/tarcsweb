import { useEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { lastRow, useStore } from './store.ts';
import { send } from './socket.ts';
import { reduceMotion, useTicker } from './bits.tsx';
import { handoffLive } from './handoff.ts';
import { activityOf, type LedPattern } from './led.tsx';
import { Robot, type RobotState } from './robot.tsx';
import { StripRobot } from './robotStrip.tsx';
import { Flap } from './flap.tsx';
import { useNarrow } from './narrow.ts';
import { useLayoutVars } from './layoutVars.ts';
import { useWatching } from './watch/open.ts';

// A step stays at least this long, so a burst of fast tools reads as steps instead of constant noise.
const HOLD = 700;
const TIMER_HOPS: [number, number] = [0, 0];
// The robot's box on the working line: big enough for the slabs to move, small enough to sit in the line.
const SIZE = 34;
// A finished turn keeps the line this long, so the robot's done, error or stopped reaction plays out.
const LINGER = { done: 1500, error: 2300, stopped: 1200 };

export function dur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// Stopwatch form for the board timer: 0:07, 12:05, 1:02:07.
function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const ss = String(s % 60).padStart(2, '0');
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}:${ss}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${ss}`;
}

type Mode = 'work' | 'compact' | 'limited';
type End = 'done' | 'error' | 'stopped';

// The robot lives on a strip above the composer; windows under 720px (the small bubble too) have no room for it,
// so they keep the working line in the conversation with its small robot.
function useStrip() {
  return !useNarrow();
}

function Line({ mode, end, bot, ref }: { mode: Mode; end: End | null; bot: boolean; ref: Ref<HTMLDivElement> }) {
  const sid = useStore((s) => s.current);
  const step = useStore((s) => (s.current ? s.maps[s.current]?.now : undefined));
  const main = useStore((s) => (s.current ? s.panels[s.current]?.agents.find((a) => a.main) : undefined));
  const resetsAt = useStore((s) => s.limits?.resetsAt ?? null);
  const now = useTicker(!end, 1000);
  const text =
    end ? (end === 'done' ? 'Done' : 'Stopped on an error')
    : mode === 'limited'
      ? `Rate limited${resetsAt ? ` · resets in ${dur(resetsAt - now)}` : ''}`
      // The line only shows with nothing left to answer, so a "Waiting for" step is from before the click.
      : mode === 'compact' ? 'Compacting the conversation' : step && !/^(Idle|Waiting for)/.test(step) ? step : 'Thinking';
  const running = main?.state === 'running';
  const label = end ? text : mode === 'compact' ? 'Compacting the conversation' : mode === 'limited' ? text : 'Working';
  // Compacting folds the robot into its wheel; the LED keeps the calm it had before.
  const robot: RobotState = end === 'stopped' ? 'idle' : end ?? (mode === 'work' ? activityOf(step) : mode === 'compact' ? 'handoff' : 'calm');
  return (
    <div ref={ref} className={`working ${mode}${end ? ` end ${end}` : ''}`}>
      {bot && <Robot size={SIZE} state={robot} led={!end && mode === 'compact' ? 'calm' : undefined} lead working />}
      <span className="step mono" title={text} aria-hidden="true">
        {/* The countdown changes every second, so only the leading words flip. */}
        <Flap text={!end && mode === 'limited' ? 'Rate limited' : text} hold={HOLD} />
        {!end && mode === 'limited' && resetsAt && <span className="rest">{text.slice('Rate limited'.length)}</span>}
      </span>
      <span className="sr" role="status">{label}</span>
      {!end && running && mode !== 'limited' && (
        <span className="st mono"><Flap tiles text={clock(now - main.startedAt)} hops={TIMER_HOPS} /></span>
      )}
      {!end && (
        <button type="button" className="k" title="Stop (Esc)" aria-label="Stop" onClick={() => sid && send({ type: 'interrupt', sessionId: sid })}>
          <kbd>esc</kbd>stop
        </button>
      )}
    </div>
  );
}

// How a running turn ended. It stays a moment for the robot's reaction; a switch, an ask or the handoff card (`hush`)
// clears it at once. Decided during render, so the line never unmounts for a frame between the turn and its ending.
function useEnding(on: boolean, hush: boolean, stopReacts: boolean, box: RefObject<HTMLDivElement | null>) {
  const sid = useStore((s) => s.current);
  const stops = useStore((s) => s.stops);
  // An error row last means it failed; a stop asked during the turn, or a prompt stopped before a reply, means Esc.
  const last = useStore((s) => {
    const it = lastRow(s);
    return it?.kind === 'error' ? 'error' : it?.kind === 'user' && it.stopped ? 'stopped' : null;
  });
  const [end, setEnd] = useState<{ sid: string; kind: End } | null>(null);
  const [was, setWas] = useState({ sid, on, stops });

  if (was.sid !== sid || was.on !== on) {
    setWas({ sid, on, stops });
    const stopped = last === 'stopped' || stops > was.stops;
    const quiet = on || was.sid !== sid || !sid || hush || (stopped && !stopReacts);
    if (quiet) setEnd(null);
    else if (was.on) setEnd({ sid, kind: stopped ? 'stopped' : last === 'error' ? 'error' : 'done' });
  } else if (end && hush) setEnd(null);
  // The error row can land just after the turn ends.
  else if (end && !on && last === 'error' && end.kind === 'done') setEnd({ ...end, kind: 'error' });

  useEffect(() => {
    if (!end) return;
    let fade: Animation | null = null;
    const t = setTimeout(() => {
      const el = box.current;
      if (!el || reduceMotion()) return setEnd(null);
      fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
      fade.finished.then(() => setEnd(null), () => {});
    }, LINGER[end.kind]);
    // A new turn during the fade keeps the line, so the fade must not stay applied.
    return () => {
      clearTimeout(t);
      fade?.cancel();
    };
  }, [end, box]);

  return end && end.sid === sid ? end.kind : null;
}

function useTurnFacts() {
  const compacting = useStore((s) => !!(s.current && s.maps[s.current]?.usage.compacting));
  const limited = useStore((s) => s.limits?.status === 'rejected');
  const working = useStore((s) => s.status === 'working');
  const asks = useStore((s) => s.asks > 0);
  // The handoff card shows its own live step.
  const handoff = useStore((s) => !!(s.current && handoffLive(s.maps[s.current]?.handoff)));
  const mode: Mode = compacting ? 'compact' : limited ? 'limited' : 'work';
  return { compacting, working, asks, handoff, mode };
}

// The working line inside the conversation, for the bubble and narrow windows.
function InlineWorking() {
  const { compacting, working, asks, handoff, mode } = useTurnFacts();
  // Hidden while a permission or choice waits for an answer.
  const on = ((working && !asks) || compacting) && !handoff;
  const box = useRef<HTMLDivElement>(null);
  const ending = useEnding(on, asks || handoff, false, box);
  if (!on && !ending) return null;
  // One Line for the turn and its ending, so the robot carries its pose from the last step into the reaction.
  return <Line ref={box} mode={mode} end={on ? null : ending} bot />;
}

export function Working() {
  return useStrip() ? null : <InlineWorking />;
}

// The strip above the composer: the robot's floor, with the working line in its top row next to the start spot.
function Strip() {
  const { compacting, working, asks, handoff, mode } = useTurnFacts();
  const step = useStore((s) => (s.current ? s.maps[s.current]?.now : undefined));
  const agents = useStore((s) => (s.current ? s.panels[s.current]?.agents : undefined));
  const on = working || compacting;
  const box = useRef<HTMLDivElement | null>(null);
  const ending = useEnding(on, handoff, true, box);
  const stripEl = useLayoutVars();
  // Delegating: no turn running (nor its ending), and at least one subagent still at work.
  const delegating = !on && !ending && !!agents?.some((a) => !a.main && a.state === 'running');
  // A pending question keeps him up, showing that it needs you; the ask card has the words.
  const state: RobotState = on
    ? asks && !compacting ? 'needs' : mode === 'work' ? activityOf(step) : mode === 'compact' ? 'handoff' : 'calm'
    : ending ?? 'idle';
  const led: LedPattern | undefined = on && mode === 'compact' ? 'calm' : delegating ? 'delegating' : undefined;
  const line = on ? !asks && !handoff : ending === 'done' || ending === 'error';
  // The robot reveals the line as he passes it on his way to the start spot.
  const clip = useRef(0);
  const paint = (el: HTMLDivElement | null) => {
    if (el) el.style.clipPath = clip.current ? `inset(0 0 0 ${clip.current}px)` : '';
  };
  const onClip = (px: number) => {
    clip.current = px;
    paint(box.current);
  };
  const lineRef = (el: HTMLDivElement | null) => {
    box.current = el;
    paint(el);
  };
  return (
    <div className="rstrip" ref={stripEl}>
      <StripRobot state={state} led={led} onClip={onClip} />
      {line && <Line ref={lineRef} mode={mode} end={on ? null : ending} bot={false} />}
    </div>
  );
}

// Only inside an open session with something in it: the Start page and a new session keep their hero robot.
// Watch mode has its own robot, so this one steps out while it is open.
export function TurnStrip() {
  const strip = useStrip();
  const sid = useStore((s) => s.current);
  const has = useStore((s) => s.order.length > 0);
  const watching = useWatching();
  if (!strip || !sid || !has || watching) return null;
  return <Strip key={sid} />;
}
