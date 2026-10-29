import { useEffect, useRef, useState } from 'react';
import type { BrowserChoice } from '../../../server/protocol.ts';
import { currentSummary, useStore } from '../store.ts';
import { send } from '../socket.ts';
import { AgentsIcon, Check, Chev } from '../bits.tsx';
import { roveMenu } from '../Menus.tsx';

const POP = 'brwChoicePop';
// null clears the pick, so the session's next browser call asks again.
const ITEMS: [BrowserChoice | null, string, string][] = [
  [null, 'Ask first', 'The next browser task asks you'],
  ['background', 'Background', 'This panel, with no window and no focus taken'],
  ['chrome', 'My Chrome', 'Your own Chrome, through Claude in Chrome'],
];

// The header's pick for the current session: where its agents' browser work runs. Opens below, right-aligned.
export function ChoiceMenu() {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const id = useStore((s) => currentSummary(s)?.id ?? null);
  const choice = useStore((s) => currentSummary(s)?.browserChoice ?? null);
  const name = ITEMS.find(([c]) => c === choice)![1];

  useEffect(() => {
    const pop = popRef.current!;
    const onToggle = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next) return;
      const r = btnRef.current!.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.right = `${Math.max(12, Math.round(innerWidth - r.right))}px`;
    };
    const onShown = (e: Event) => {
      if ((e as ToggleEvent).newState === 'open') pop.querySelector<HTMLElement>('.mi[aria-checked="true"]')?.focus({ preventScroll: true });
    };
    pop.addEventListener('beforetoggle', onToggle);
    pop.addEventListener('toggle', onShown);
    return () => {
      pop.removeEventListener('beforetoggle', onToggle);
      pop.removeEventListener('toggle', onShown);
    };
  }, []);

  const pick = (next: BrowserChoice | null) => {
    popRef.current!.hidePopover();
    if (!id || next === choice) return;
    if (!send({ type: 'set-browser', sessionId: id, choice: next })) useStore.setState({ notice: 'Not connected', noticeInfo: false });
  };

  return (
    <>
      <button
        type="button" ref={btnRef} className="brw-agents" popoverTarget={POP} disabled={!id}
        aria-haspopup="menu" aria-expanded={open} aria-label={`Browser for this session's agents: ${name}`}
        title={id ? "Where this session's agents browse" : 'Open a session first'}
      >
        <AgentsIcon /><span className="v">{name}</span><Chev />
      </button>
      <div className="pop ctx brw-choice-pop" id={POP} popover="auto" ref={popRef} role="menu" aria-label="Browser for this session" onKeyDown={roveMenu}>
        <div className="pg"><span>Where this session's agents browse</span></div>
        {ITEMS.map(([c, n, d]) => (
          <button key={c ?? 'ask'} type="button" className="mi" role="menuitemradio" aria-checked={c === choice} onClick={() => pick(c)}>
            <span className="nm2">{n}</span><small>{d}</small>
            <span className="side"><span className="ck"><Check /></span></span>
          </button>
        ))}
      </div>
    </>
  );
}
