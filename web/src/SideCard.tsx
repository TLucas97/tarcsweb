import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from './store.ts';
import { AgentsIcon, Check, ExpandIcon, WorkIcon, morphBox, pref, useEscape } from './bits.tsx';
import { Led } from './led.tsx';
import { usePills } from './narrow.ts';
import { useLayoutVars } from './layoutVars.ts';
import { Agents } from './Agents.tsx';
import { SessionMap } from './SessionMap.tsx';
import { MIN_KEY, morph, pickTab, setFull, setMin, useSide } from './sideState.ts';

// Tasks, Agents and Files in one card on the right, one tab at a time. It stays open until minimized on purpose,
// then it is one button in the same spot. Full screen morphs the whole card, tabs included.
export function SideCard() {
  const sessionId = useStore((s) => s.current);
  const started = useStore((s) => s.order.length > 0);
  const working = useStore((s) => s.status === 'working');
  const { tab, min, full, work, tasksDone, agents, agentState, files } = useSide();
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
  const visible = !!sessionId && started;

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
      <aside ref={cardEl} className={`scard${min ? ' tucked' : ''}${full ? ' full' : ''}`} aria-label="Tasks, agents and files" hidden={!visible} inert={min}>
        <div className="sc-head">
          <div className="wk-view sc-tabs" role="tablist" aria-label="Panels" style={{ '--i': tab === 'tasks' ? 0 : tab === 'agents' ? 1 : 2 } as CSSProperties}>
            <span className="wk-pill" aria-hidden="true"></span>
            <button type="button" role="tab" id="sc-t-tasks" aria-controls="sc-tasks" aria-selected={tab === 'tasks'} aria-label={`Tasks · ${taskStatus}${work ? ` · ${work} steps` : ''}`} data-state={busy ? 'running' : tasksDone ? 'done' : 'idle'} title={`Tasks · ${taskStatus}${work ? ` · ${work} steps` : ''}`} onClick={() => pickTab('tasks')}>
              <span className="sc-tab-name">Tasks</span>
              <span className="sc-tab-status" aria-hidden="true">{busy ? <Led size="sm" pattern={working ? 'calm' : 'delegating'} /> : tasksDone ? <Check /> : null}{work ? work.replace(' of ', '/') : !busy ? '—' : null}</span>
            </button>
            <button type="button" role="tab" id="sc-t-agents" aria-controls="sc-agents" aria-selected={tab === 'agents'} aria-label={`Agents · ${agentStatus}`} data-state={agentState} title={`Agents · ${agentStatus}`} onClick={() => pickTab('agents')}>
              <span className="sc-tab-name">Agents</span>
              <span className="sc-tab-status" aria-hidden="true">{agentState === 'running' ? <Led size="sm" pattern="calm" /> : agentState === 'waiting' ? 'Ⅱ' : agentState === 'done' ? <Check /> : agentState === 'failed' ? '!' : '—'}{agents > 0 ? agents : null}</span>
            </button>
            <button type="button" role="tab" id="sc-t-files" aria-controls="sc-files" aria-selected={tab === 'files'} aria-label={`Files · ${files} changed this session`} title={`${files} files changed this session`} onClick={() => pickTab('files')}>
              <span className="sc-tab-name">Files</span>
              <span className="sc-tab-status" aria-hidden="true">{files}</span>
            </button>
          </div>
          <button className="min expand" aria-pressed={full} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (esc)' : 'Full screen'} onClick={() => setFull(!full)}>
            <ExpandIcon out={full} />
          </button>
          <button className="min sc-fold" aria-label="Minimize tasks, agents and files" title="Minimize" onClick={close}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
          </button>
        </div>
        <SessionMap tab={tab} full={full} />
        <Agents on={tab === 'agents'} full={full} />
      </aside>
      <div className="scrim sc-scrim" aria-hidden="true" onClick={() => (full ? setFull(false) : close())} />
      <button
        ref={miniEl} type="button" className={`sc-mini${min ? ' on' : ''}`} hidden={!visible} inert={!min}
        aria-label="Open tasks, agents and files" title={`Tasks · ${taskStatus}; Agents · ${agentStatus}; ${files} files changed`} onClick={open}
      >
        {busy ? <span className="sm-led"><Led size="sm" pattern={working ? 'calm' : 'delegating'} /></span> : <WorkIcon />}
        <b>Work</b>
        {work && <em>{work}</em>}
        {agents > 0 && <span className="sc-ag"><AgentsIcon />{agents}</span>}
      </button>
    </>
  );
}
