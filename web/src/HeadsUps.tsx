import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HeadsUp } from '../../server/protocol.ts';
import { dismissLocal, pickAgent, useStore } from './store.ts';
import { openSession, send } from './socket.ts';
import { openLog } from './Agents.tsx';
import { goTo } from './bits.tsx';
import { PluginBand } from './PluginBand.tsx';
import { setLayoutVar, useLayoutVars } from './layoutVars.ts';
import { answerAsk, useAnswering } from './answering.ts';

const ACTION = { review: 'Review', log: 'Open log', switch: 'Switch', 'force-stop': 'Force stop', agent: 'Open agent' } as const;
const SHOWN = 3;

function act(sessionId: string, h: HeadsUp) {
  const a = h.action;
  if (!a) return;
  if (a.kind === 'review') goTo(a.target);
  else if (a.kind === 'log') openLog(sessionId, a.target);
  else if (a.kind === 'force-stop') {
    if (!send({ type: 'force-stop', sessionId })) useStore.setState({ notice: 'Not connected', noticeInfo: false });
  } else if (a.kind === 'agent') pickAgent(sessionId, a.target);
  else openSession(a.target);
}

// A plain permission can be answered from the notice, since its card may sit far up or outside the loaded history.
function Answer({ sessionId, h }: { sessionId: string; h: HeadsUp }) {
  const id = h.action?.kind === 'review' && h.id.startsWith('perm:') ? h.action.target : null;
  const simple = useStore((s) => {
    const it = id ? s.items[id] : undefined;
    if (!id) return false;
    if (it?.kind !== 'permission') return /^(A command|A file edit) /.test(h.text);
    return it.answer === null && !it.questions && it.plan === undefined;
  });
  const no = useStore((s) => {
    const it = id ? s.items[id] : undefined;
    return it?.kind === 'permission' && !!it.defaultToNo;
  });
  // One answer per ask, shared with the card and the keys; the notice goes away once the server resolves it.
  const sent = useAnswering((s) => !!(id && s.ids[id]));
  if (!id || !simple) return null;
  const answer = (allow: boolean) => void answerAsk(sessionId, id, allow);
  return (
    <>
      <button className={`hu-act${no ? ' allow' : ''}`} disabled={sent} data-robot-react="tense" onClick={() => answer(false)}>Deny</button>
      <button className={`hu-act${no ? '' : ' allow'}`} disabled={sent} data-robot-react="happy" onClick={() => answer(true)}>Allow</button>
    </>
  );
}

function dismiss(sessionId: string, id: string) {
  if (send({ type: 'dismiss', sessionId, id })) dismissLocal(sessionId, id);
}

// Sits above the composer (above the robot strip in a session) with plugins' band last; --hh lifts the conversation's bottom edge by its height.
export function HeadsUps() {
  const sessionId = useStore((s) => s.current);
  const hus = useStore((s) => (s.current ? s.maps[s.current]?.headsUps : undefined)) ?? [];
  const above = useStore((s) => (s.current ? s.maps[s.current]?.above : null)) ?? null;
  const [all, setAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const husEl = useLayoutVars(ref);
  const has = hus.length > 0 || above !== null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return setLayoutVar('--hh', null);
    const ro = new ResizeObserver(([e]) => setLayoutVar('--hh', Math.round(e.borderBoxSize[0].blockSize) + 8 + 'px'));
    ro.observe(el);
    return () => {
      ro.disconnect();
      setLayoutVar('--hh', null);
    };
  }, [has]);

  if (!has || !sessionId) return null;
  const list = all ? hus : hus.slice(0, SHOWN);
  const more = hus.length - list.length;
  return (
    <div className="hus" ref={husEl} role="status" aria-label="Heads-up">
      {list.map((h) => (
        <div key={h.id} className={`hub${h.need ? ' need' : ''}`}>
          <i className="d"></i>
          <span className="tx" title={h.detail ? `${h.text}\n${h.detail}` : h.text}>
            {h.text}{h.detail && <small>{h.detail}</small>}
          </span>
          {h.action && <button className="hu-act" onClick={() => act(sessionId, h)}>{ACTION[h.action.kind]}</button>}
          <Answer sessionId={sessionId} h={h} />
          {h.dismissable && (
            <button className="hu-x" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(sessionId, h.id)}>
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2 2 8" /></svg>
            </button>
          )}
        </div>
      ))}
      {(more > 0 || all) && hus.length > SHOWN && (
        <button className="hus-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `${more} more`}</button>
      )}
      {above !== null && <PluginBand sessionId={sessionId} tree={above} />}
    </div>
  );
}
