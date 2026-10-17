import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { closeSession, deleteSession, setArchived } from './actions.ts';
import { ArchiveIcon, Check, PencilIcon, TrashIcon, XIcon, useArm } from './bits.tsx';
import { PhoneIcon, toggleRemote } from './Remote.tsx';
import { handoffLive } from './handoff.ts';
import { send } from './socket.ts';
import { useStore } from './store.ts';
import { WIDGET_MAX, removeWidget, useWidgets, widgetFor } from './widgets/state.ts';

const ReloadIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 6A4.5 4.5 0 1 1 9.2 2.8M10 1v2.4H7.6" /></svg>
);
const WidgetIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="1.2" y="1.8" width="9.6" height="8.4" rx="2" /><path d="M3.6 4.4h4.8M3.6 6.4h2.8" /></svg>
);
const HandoffIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.8 1.2h3.9l2.5 2.4v7.2H2.8zM6.6 1.2v2.4h2.6M4.4 6.2h3M4.4 8.2h3" /></svg>
);

// past: a closed session shown in the dock; it opens instead of closing and has no inline rename.
export type MenuTarget = { id: string; left: number; top: number; past?: boolean };

export const HistIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="6" cy="6" r="4.6" /><path d="M6 3.6V6l1.6 1.1" /></svg>
);

// Right-click menu for a dock tab; opens below the tab, styled like the composer popovers.
export function SessionMenu({ target, onClose, onRename }: { target: MenuTarget | null; onClose: () => void; onRename: (id: string) => void }) {
  const popRef = useRef<HTMLDivElement>(null);
  const [armed, press] = useArm();

  useLayoutEffect(() => {
    const pop = popRef.current!;
    if (!target) {
      if (pop.matches(':popover-open')) pop.hidePopover();
      return;
    }
    // 272px menu plus a 12px margin, so it never runs off a narrow window.
    pop.style.left = Math.min(target.left, innerWidth - 284) + 'px';
    pop.style.top = target.top + 'px';
    if (!pop.matches(':popover-open')) pop.showPopover();
    pop.querySelector<HTMLElement>('.mi')?.focus({ preventScroll: true });
  }, [target]);

  useEffect(() => {
    const pop = popRef.current!;
    const onToggle = (e: Event) => (e as ToggleEvent).newState === 'closed' && onClose();
    pop.addEventListener('toggle', onToggle);
    return () => pop.removeEventListener('toggle', onToggle);
  }, [onClose]);

  const id = target?.id ?? '';
  const busy = useStore((s) => {
    const r = s.roster.find((x) => x.id === id);
    return !!r && (r.state === 'working' || r.state === 'waiting' || !!r.background);
  });
  // Background agents block a reload but not a handoff, like the automatic one.
  const working = useStore((s) => {
    const r = s.roster.find((x) => x.id === id);
    return !!r && (r.state === 'working' || r.state === 'waiting');
  });
  const handing = useStore((s) => handoffLive(s.maps[id]?.handoff));
  const remote = useStore((s) => s.roster.find((x) => x.id === id)?.remote);
  const remoteOn = !!remote && remote.state !== 'error';
  // Codex tabs have neither; an older server sends no caps.
  const canRemote = useStore((s) => s.roster.find((x) => x.id === id)?.caps?.remote !== false);
  const canHandoff = useStore((s) => s.roster.find((x) => x.id === id)?.caps?.handoff !== false);
  const isCurrent = useStore((s) => s.current === id);
  const widget = useWidgets((s) => s.list.some((w) => w.id === id));
  const widgetsFull = useWidgets((s) => s.list.length >= WIDGET_MAX);
  const act = (fn: () => void) => () => {
    popRef.current!.hidePopover();
    fn();
  };
  const onDelete = () => {
    if (press(id)) act(() => deleteSession(id))();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...popRef.current!.querySelectorAll<HTMLElement>('.mi')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  const isArmed = !!target && armed === id;

  return (
    <div className="pop mpop ctx" popover="auto" ref={popRef} role="menu" aria-label="Session" onKeyDown={onKeyDown}>
      {target?.past ? (
        <>
          <button className="mi" role="menuitem" onClick={act(() => send({ type: 'resume', id }))}>
            <span className="nm2"><HistIcon />Open</span><small>Picks it up where it stopped</small>
          </button>
          <button className="mi" role="menuitem" disabled={widgetsFull} onClick={act(() => widgetFor(id, false))}>
            <span className="nm2"><WidgetIcon />Open as widget</span>
            <small>{widgetsFull ? `Up to ${WIDGET_MAX} widgets` : 'Reopens it beside this session'}</small>
          </button>
        </>
      ) : (
        <>
          <button className="mi" role="menuitem" onClick={act(() => closeSession(id))}>
            <span className="nm2"><XIcon />Close</span><small>Stops it here; the history stays</small>
            <span className="side"><kbd>alt W</kbd></span>
          </button>
          <button className="mi" role="menuitem" onClick={act(() => onRename(id))}>
            <span className="nm2"><PencilIcon />Rename</span><small>Also renames it in the terminal</small>
          </button>
          {widget ? (
            <button className="mi" role="menuitem" onClick={act(() => removeWidget(id))}>
              <span className="nm2"><WidgetIcon />Remove widget</span><small>The session keeps running</small>
            </button>
          ) : (
            <button className="mi" role="menuitem" disabled={widgetsFull} onClick={act(() => widgetFor(id, true))}>
              <span className="nm2"><WidgetIcon />Open as widget</span>
              <small>{widgetsFull ? `Up to ${WIDGET_MAX} widgets` : isCurrent ? 'Shows up once you switch sessions' : 'Chat with it from any session'}</small>
            </button>
          )}
          <button className="mi" role="menuitem" disabled={busy} onClick={act(() => send({ type: 'reload', sessionId: id }))}>
            <span className="nm2"><ReloadIcon />Reload</span>
            <small>{busy ? 'Available once it finishes' : 'Picks up new instructions and settings'}</small>
          </button>
          {canHandoff && (
            <button className="mi" role="menuitem" disabled={working || handing} onClick={act(() => send({ type: 'handoff', sessionId: id }))}>
              <span className="nm2"><HandoffIcon />Hand off now</span>
              <small>{handing ? 'A handoff is running' : working ? 'Available once it finishes' : 'Writes a handoff, then compacts'}</small>
            </button>
          )}
          {canRemote && (
            <button className="mi" role="menuitemcheckbox" aria-checked={remoteOn} onClick={act(() => toggleRemote(id, !remoteOn))}>
              <span className="nm2"><PhoneIcon />Remote Control</span>
              <small>{remote?.state === 'connecting' ? 'Connecting… click to turn off' : remoteOn ? 'On. Click to turn off' : 'Continue it from your phone'}</small>
              <span className="side"><span className="ck"><Check /></span></span>
            </button>
          )}
        </>
      )}
      <button className="mi" role="menuitem" onClick={act(() => setArchived(id, true))}>
        <span className="nm2"><ArchiveIcon />Archive</span><small>Closes it and hides it from the list</small>
      </button>
      <div className="sep"></div>
      <button className={`mi${isArmed ? ' danger' : ''}`} role="menuitem" onClick={onDelete}>
        <span className="nm2"><TrashIcon />{isArmed ? 'Delete forever?' : 'Delete'}</span>
        <small>{isArmed ? 'Click again. It also disappears from claude --resume' : 'Removes the transcript for good'}</small>
      </button>
    </div>
  );
}
