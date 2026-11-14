import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from './store.ts';
import { AgentsIcon, CallIcon, Check, ExpandIcon, WorkIcon, morphBox, pref, useEscape } from './bits.tsx';
import { Led } from './led.tsx';
import { usePills } from './narrow.ts';
import { useLayoutVars } from './layoutVars.ts';
import { Agents } from './Agents.tsx';
import { SessionMap } from './SessionMap.tsx';
import { ChunkGuard } from './Stale.tsx';
import { setCallFull, useCallMark, type CallMark } from './call.ts';
import { MIN_KEY, morph, pickTab, savedTab, setFull, setMin, useSide, type SideTab } from './sideState.ts';

// Loads with the first call.
const CallTab = lazy(() => import('./CallTab.tsx'));

const CALL_STATUS: Record<CallMark, string> = {
  connecting: 'Connecting', live: 'On call', working: 'Codex is working', ended: 'Call ended', error: 'Call failed',
};

// Tasks, Agents and Files in one card on the right, one tab at a time, plus tabs that exist only while their source
// does (Call during a voice call). It stays open until minimized on purpose, then it is one button in the same spot.
// Full screen morphs the whole card, tabs included.
export function SideCard() {
  const sessionId = useStore((s) => s.current);
  const started = useStore((s) => s.order.length > 0);
  const working = useStore((s) => s.status === 'working');
  const { tab, min, full, stepsDone, stepsTotal, agents, agentState, files } = useSide();
  const work = stepsTotal ? `${stepsDone} of ${stepsTotal}` : '';
  const tasksDone = stepsTotal > 0 && stepsDone === stepsTotal;
  const call = useCallMark();
  const tabs: SideTab[] = call ? ['tasks', 'agents', 'files', 'call'] : ['tasks', 'agents', 'files'];
  // A tab whose source went away hands the card back to the last saved tab.
  const shown = tabs.includes(tab) ? tab : savedTab();
  useEffect(() => {
    if (shown !== tab) useSide.setState({ tab: shown });
  }, [shown, tab]);
  // On the Call tab the card's own full screen is the call's.
  const callFull = shown === 'call' && !full;
  const agentsActive = agentState === 'running' || agentState === 'waiting';
  const busy = working || agentsActive;
  const taskStatus = working ? 'Working' : agentsActive ? 'Delegating' : tasksDone ? 'Done' : 'Idle';
  const agentStatus = agentState === 'running' ? (agents ? `${agents} active` : 'Running')
    : agentState === 'waiting' ? (agents ? `${agents} waiting` : 'Waiting')
    : agentState === 'failed' ? 'Failed' : agentState === 'done' ? 'Done' : 'Idle';
  const narrow = usePills();
  const cardRef = useRef<HTMLElement>(null);
  const miniRef = useRef<HTMLButtonElement>(null);
  const cardEl = useLayoutVars(cardRef);
  const miniEl = useLayoutVars(miniRef);
  // A call keeps the card up anywhere, Start screen included, so its tab stays reachable.
  const visible = (!!sessionId && started) || call !== null;

  // Narrow, the open card is a sheet over the text, so it starts minimized there without saving that.
  useLayoutEffect(() => {
    useSide.setState({ sessionId, min: !!sessionId && (narrow || pref.get<string[]>(MIN_KEY, []).includes(sessionId)), full: false });
  }, [sessionId, narrow]);

  useLayoutEffect(() => {
    morph.el = cardRef.current;
    return () => void (morph.el = null);
  }, []);
  useLayoutEffect(() => {
    const from = morph.from;
    morph.from = null;
    if (from && cardRef.current) morphBox(cardRef.current, from, full);
  }, [full]);
  useLayoutEffect(() => {
    if (!visible) useSide.setState({ full: false });
  }, [visible]);

  useEscape(full, () => setFull(false));
  // Narrow, the open card is a sheet over the text, so Esc puts it away.
  useEscape(narrow && !min && !full, () => setMin(true));

  // Focus follows the control that replaced the one clicked.
  const close = () => {
    flushSync(() => setMin(true));
    miniRef.current?.focus({ preventScroll: true });
  };
  const open = () => {
    flushSync(() => setMin(false));
    cardRef.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({ preventScroll: true });
  };

  return (
    <>
      <aside ref={cardEl} className={`scard${min ? ' tucked' : ''}${full ? ' full' : ''}`} aria-label={call ? 'Tasks, agents, files and call' : 'Tasks, agents and files'} hidden={!visible} inert={min}>
        <div className="sc-head">
          <div className="wk-view sc-tabs" role="tablist" aria-label="Panels" style={{ '--i': tabs.indexOf(shown), '--n': tabs.length } as CSSProperties}>
            <span className="wk-pill" aria-hidden="true"></span>
            <button type="button" role="tab" id="sc-t-tasks" aria-controls="sc-tasks" aria-selected={shown === 'tasks'} aria-label={`Tasks · ${taskStatus}${work ? ` · ${work} steps` : ''}`} data-state={busy ? 'running' : tasksDone ? 'done' : 'idle'} title={`Tasks · ${taskStatus}${work ? ` · ${work} steps` : ''}`} onClick={() => pickTab('tasks')}>
              <span className="sc-tab-name">Tasks</span>
              <span className="sc-tab-status" aria-hidden="true">{busy ? <Led size="sm" pattern={working ? 'calm' : 'delegating'} /> : tasksDone ? <Check /> : null}{work ? work.replace(' of ', '/') : !busy ? '—' : null}</span>
            </button>
            <button type="button" role="tab" id="sc-t-agents" aria-controls="sc-agents" aria-selected={shown === 'agents'} aria-label={`Agents · ${agentStatus}`} data-state={agentState} title={`Agents · ${agentStatus}`} onClick={() => pickTab('agents')}>
              <span className="sc-tab-name">Agents</span>
              <span className="sc-tab-status" aria-hidden="true">{agentState === 'running' ? <Led size="sm" pattern="calm" /> : agentState === 'waiting' ? 'Ⅱ' : agentState === 'done' ? <Check /> : agentState === 'failed' ? '!' : '—'}{agents > 0 ? agents : null}</span>
            </button>
            <button type="button" role="tab" id="sc-t-files" aria-controls="sc-files" aria-selected={shown === 'files'} aria-label={`Files · ${files} changed this session`} title={`${files} files changed this session`} onClick={() => pickTab('files')}>
              <span className="sc-tab-name">Files</span>
              <span className="sc-tab-status" aria-hidden="true">{files}</span>
            </button>
            {call && (
              <button type="button" role="tab" id="sc-t-call" aria-controls="sc-call" aria-selected={shown === 'call'} aria-label={`Call · ${CALL_STATUS[call]}`} data-call={call} title={`Call · ${CALL_STATUS[call]}`} onClick={() => pickTab('call')}>
                <span className="sc-tab-name">Call</span>
                <span className="sc-tab-status" aria-hidden="true">{call === 'working' ? <Led size="sm" pattern="calm" /> : <i className="sc-call-dot" />}</span>
              </button>
            )}
          </div>
          <button
            className="min expand" aria-pressed={full} aria-label={full ? 'Exit full screen' : callFull ? 'Show the call full screen' : 'Full screen'}
            title={full ? 'Exit full screen (esc)' : callFull ? 'Show the call full screen' : 'Full screen'} onClick={() => (callFull ? setCallFull(true) : setFull(!full))}
          >
            <ExpandIcon out={full} />
          </button>
          <button className="min sc-fold" aria-label="Minimize the side panel" title="Minimize" onClick={close}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
          </button>
        </div>
        <SessionMap tab={shown} full={full} />
        <Agents on={shown === 'agents'} full={full} />
        {call && <ChunkGuard><Suspense fallback={null}><CallTab on={shown === 'call' && !min && visible} /></Suspense></ChunkGuard>}
      </aside>
      <div className="scrim sc-scrim" aria-hidden="true" onClick={() => (full ? setFull(false) : close())} />
      <button
        ref={miniEl} type="button" className={`sc-mini${min ? ' on' : ''}`} hidden={!visible} inert={!min}
        aria-label="Open the side panel" title={`Tasks · ${taskStatus}; Agents · ${agentStatus}; ${files} files changed${call ? `; Call · ${CALL_STATUS[call]}` : ''}`} onClick={open}
      >
        {busy ? <span className="sm-led"><Led size="sm" pattern={working ? 'calm' : 'delegating'} /></span> : <WorkIcon />}
        <b>Work</b>
        {work && <em>{work}</em>}
        {agents > 0 && <span className="sc-ag"><AgentsIcon />{agents}</span>}
        {call && <span className="sc-callmk" data-call={call}><CallIcon /></span>}
      </button>
    </>
  );
}
