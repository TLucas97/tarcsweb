import { useEffect, useRef, type KeyboardEvent } from 'react';
import { moveSession, sessionOrder, useStore } from './store.ts';
import { openSession } from './socket.ts';
import { usePins } from './prefs.ts';
import { ownsCtrlKeys } from './embed.ts';
import { baseName } from './bits.tsx';
import { PinIcon } from './SessionMenu.tsx';
import { useRowDrag } from './DockFolders.tsx';
import { SessionTile } from './sessionColor.tsx';

const ArrangeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5v9M1.8 4.7 4 2.5l2.2 2.2M10 11.5v-9M7.8 9.3l2.2 2.2 2.2-2.2" /></svg>
);

// The sidebar header's Arrange button: every open session in Ctrl/Alt+digit order, each row draggable on its own.
// Pinned ones always lead, so they sit on top without a drag.
export function ArrangeMenu() {
  const roster = useStore((s) => s.roster);
  const dockOrder = useStore((s) => s.dockOrder);
  const current = useStore((s) => s.current);
  const pins = usePins();
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const byId = new Map(roster.map((r) => [r.id, r]));
  const pinned = new Set(pins);
  const order = sessionOrder({ roster, dockOrder }, pins);
  const mod = ownsCtrlKeys() ? 'Ctrl' : 'Alt';

  useRowDrag(listRef, {
    grab: '.ar-row:not([data-pin])', item: (el) => el,
    peers: (box) => [...box.querySelectorAll<HTMLElement>('.ar-row:not([data-pin])')],
    onDrop: (id, to, after) => moveSession([id], [to], after),
  });

  // Opens to the sidebar's right, level with the button, like the session menu.
  useEffect(() => {
    const pop = popRef.current!;
    const onBefore = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open') return;
      const b = btnRef.current!.getBoundingClientRect();
      const top = Math.max(12, b.top - 6);
      pop.style.left = (btnRef.current!.closest('.dpanel')?.getBoundingClientRect().right ?? b.right) + 10 + 'px';
      pop.style.top = top + 'px';
      pop.style.maxHeight = `calc(100vh - ${top + 12}px)`;
    };
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'open') pop.querySelector<HTMLElement>('.ar-row[aria-current], .ar-row')?.focus({ preventScroll: true });
    };
    pop.addEventListener('beforetoggle', onBefore);
    pop.addEventListener('toggle', onToggle);
    return () => {
      pop.removeEventListener('beforetoggle', onBefore);
      pop.removeEventListener('toggle', onToggle);
    };
  }, []);

  const pick = (id: string) => {
    popRef.current!.hidePopover();
    if (id !== current) openSession(id);
  };
  // Arrows move focus; Alt+arrows move the focused session, the keyboard's drag.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...listRef.current!.querySelectorAll<HTMLElement>('.ar-row')];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    if (!e.altKey) return rows[(i + dir + rows.length) % rows.length]?.focus();
    const row = rows[i];
    const to = rows[i + dir];
    if (!row || !to || row.hasAttribute('data-pin') || to.hasAttribute('data-pin')) return;
    moveSession([row.dataset.id!], [to.dataset.id!], dir > 0);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`.ar-row[data-id="${row.dataset.id}"]`)?.focus());
  };

  return (
    <>
      <button
        type="button" className="dp-ib" ref={btnRef} popoverTarget="arrangePop" aria-haspopup="dialog" aria-label="Arrange sessions" title="Arrange sessions"
      ><ArrangeIcon /></button>
      <div className="pop mpop ctx ar-pop" id="arrangePop" popover="auto" ref={popRef} role="dialog" aria-label="Arrange sessions" onKeyDown={onKeyDown}>
        <div className="pg"><span>Session order</span></div>
        <div className="ar-list" ref={listRef}>
          {order.map((id, i) => {
            const r = byId.get(id)!;
            const pin = pinned.has(id);
            return (
              <button
                key={id} type="button" className="ar-row" data-id={id} data-pin={pin ? '' : undefined} aria-current={id === current || undefined}
                title={pin ? `${r.name} · Pinned, stays on top` : r.name} onClick={() => pick(id)}
              >
                <span className="ar-n">{i < 9 ? i + 1 : ''}</span>
                <SessionTile id={id} state={r.state} needsYou={r.needsYou} background={r.background} />
                <span className="ar-nm" dir="auto">{r.name}</span>
                <span className="ar-f">{baseName(r.cwd)}</span>
                {pin && <span className="ar-pin" aria-hidden="true"><PinIcon /></span>}
              </button>
            );
          })}
          {!order.length && <p className="dp-empty">No open sessions.</p>}
        </div>
        <p className="ar-foot">{mod}+1–9 switches to that session</p>
      </div>
    </>
  );
}
