import { Component, lazy, Suspense, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from './store.ts';
import { openSession } from './socket.ts';
import { reduceMotion, subscribe, useLite } from './perf.ts';
import { ExpandIcon } from './bits.tsx';
import { showTab } from './sideState.ts';
import { callActive, setCallFull, type CallView } from './call.ts';
import { Actions, Elapsed, Feed, Outcome, Usage, callDone, callStatus } from './CallPanel.tsx';

// three.js and its renderer load only for a call outside Lite.
const CallOrb = lazy(() => import('./CallOrb.tsx'));

// A WebGL start or chunk that fails leaves the still circle under it, which is the orb's poster anyway.
class OrbGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Folding the call away opens the side card on its Call tab.
const minimize = () => {
  setCallFull(false);
  showTab('call');
};

// The call over the whole app: the orb alone in the middle, Codex's work beside it. Esc or Minimize folds it into the
// side card's Call tab.
export default function CallFull({ call }: { call: CallView }) {
  const ref = useRef<HTMLDialogElement>(null);
  const lite = useLite();
  const still = useSyncExternalStore(subscribe, reduceMotion);
  const roster = useStore((s) => s.roster);
  const waiting = roster.find((r) => r.id === call.sessionId)?.needsYou === true;
  useEffect(() => {
    const d = ref.current!;
    if (call.full && !d.open) d.showModal();
    else if (!call.full && d.open) d.close();
  }, [call.full]);
  const connecting = call.ending || call.state === 'connecting' || call.state === 'reconnecting';
  const { live, tone, text } = callStatus(call);
  const done = callDone(call);
  return (
    <dialog
      ref={ref} className="vc" aria-label="Voice call with Codex"
      onCancel={(e) => {
        e.preventDefault();
        minimize();
      }}
      // Chrome closes anyway on a second Esc with no click between; a close this screen asked for is not one.
      onClose={() => call.full && minimize()}
    >
      <header className={`rc-head vc-head ${tone}`}>
        <i aria-hidden="true" />
        <span role="status">{text}</span>
        {live && call.liveAt !== null && call.full && <Elapsed from={call.liveAt} />}
        <span className="vc-who" title={call.name}>Codex · {call.name}</span>
        <button type="button" className="vc-min" title="Keep the call in the side panel (Esc)" onClick={minimize}><ExpandIcon out />Minimize</button>
      </header>
      <div className="vc-main">
        <div className={`vc-orb${callActive(call) ? '' : ' off'}`}>
          {callActive(call) && !lite && (
            <OrbGuard><Suspense fallback={null}><CallOrb on={call.full} still={still} thinking={connecting || call.busy} /></Suspense></OrbGuard>
          )}
        </div>
        {/* The orb stands alone during the call; the report flow comes in under it after End. */}
        {done && <div className="vc-out"><Outcome call={call} /></div>}
      </div>
      <aside className="vc-side" aria-label="Codex's work">
        {!done && call.error && <p className="vc-err" role="alert">{call.error}</p>}
        {waiting && (
          <div className="vc-wait" role="status">
            <span>{call.name} is waiting for you in its tab.</span>
            <button
              type="button" onClick={() => {
                setCallFull(false);
                openSession(call.sessionId);
              }}
            >
              Open tab
            </button>
          </div>
        )}
        <section className="vc-act" aria-labelledby="vc-act-h">
          <h2 id="vc-act-h" className="vc-h">What Codex is doing</h2>
          <Feed acts={call.acts} />
        </section>
        <Usage usage={call.usage} />
      </aside>
      <footer className="vc-foot"><Actions call={call} /></footer>
    </dialog>
  );
}
