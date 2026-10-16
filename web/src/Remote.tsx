import { useEffect, useRef, useState } from 'react';
import { currentSummary, useStore } from './store.ts';
import { send } from './socket.ts';
import { CopyBtn } from './bits.tsx';
import type { RemoteState } from '../../server/protocol.ts';

export const PhoneIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="1" width="6" height="10" rx="1.4" /><path d="M5.2 9h1.6" />
  </svg>
);

export const toggleRemote = (sessionId: string, on: boolean) => send({ type: 'remote-control', sessionId, on });

const LABEL: Record<RemoteState['state'], string> = { connecting: 'Connecting…', on: 'Remote', error: 'Remote failed' };
const HEAD: Record<RemoteState['state'], string> = { connecting: 'Connecting to claude.ai…', on: 'Remote Control is on', error: 'Remote Control stopped' };

// A small mark on the dock tab while Remote Control is on.
export function TabPhone({ state }: { state: RemoteState['state'] }) {
  return <span className={`rc-tab ${state}`} title={`Remote Control: ${state === 'on' ? 'on' : state === 'connecting' ? 'connecting' : 'failed'}`}><PhoneIcon size={11} /></span>;
}

// Title bar chip for the current session; it opens the link with Copy, Open and Turn off.
export function RemoteChip() {
  const summary = useStore(currentSummary);
  const remote = summary?.remote;
  const shown = !!remote;
  const id = summary?.id ?? '';
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const p = pop.current;
    if (!p) return;
    const onToggle = (e: Event) => setOpen((e as ToggleEvent).newState === 'open');
    p.addEventListener('toggle', onToggle);
    // Turned off elsewhere: the popover leaves with the chip.
    return () => {
      p.removeEventListener('toggle', onToggle);
      setOpen(false);
    };
  }, [shown]);

  if (!remote) return null;
  const toggle = () => {
    const p = pop.current!;
    if (p.matches(':popover-open')) return p.hidePopover();
    const r = btn.current!.getBoundingClientRect();
    // 320px popover centred under the chip, kept 12px inside the window.
    p.style.left = Math.max(12, Math.min(r.left + r.width / 2 - 160, innerWidth - 332)) + 'px';
    p.style.top = r.bottom + 8 + 'px';
    p.showPopover();
  };
  const close = () => pop.current?.hidePopover();

  return (
    <>
      <button
        ref={btn} type="button" className={`rc-chip ${remote.state}`} aria-haspopup="dialog" aria-expanded={open} aria-busy={remote.state === 'connecting'}
        title="Remote Control" onClick={toggle}
      >
        <PhoneIcon />
        <span>{LABEL[remote.state]}</span>
      </button>
      <div className="pop rc-pop" popover="auto" ref={pop} role="dialog" aria-label="Remote Control">
        <div className={`rc-head ${remote.state}`} role="status"><i aria-hidden="true"></i>{HEAD[remote.state]}</div>
        {remote.state === 'error' ? (
          <p className="rc-sub bad">{remote.error ?? 'The connection to claude.ai failed.'}</p>
        ) : (
          <p className="rc-sub">Continue this session in the Claude app or at claude.ai/code. It stays on while this session is open.</p>
        )}
        {remote.url ? (
          <div className="rc-url">
            <span className="mono" title={remote.url}>{remote.url.replace(/^https:\/\//, '')}</span>
            <CopyBtn text={remote.url} what="link" />
          </div>
        ) : remote.state === 'connecting' ? (
          <div className="rc-url wait"><span>The link shows up once it connects</span></div>
        ) : null}
        <div className="rc-acts">
          <button type="button" className="rc-off" onClick={() => (close(), toggleRemote(id, false))}>{remote.state === 'error' ? 'Dismiss' : 'Turn off'}</button>
          {remote.state === 'error' ? (
            <button type="button" className="rc-go" onClick={() => toggleRemote(id, true)}>Try again</button>
          ) : remote.url ? (
            <a className="rc-go" href={remote.url} target="_blank" rel="noreferrer" onClick={close}>Open</a>
          ) : null}
        </div>
      </div>
    </>
  );
}
