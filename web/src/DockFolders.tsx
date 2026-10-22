import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionSummary } from '../../server/protocol.ts';
import { setPalette, useStore } from './store.ts';
import { openSession } from './socket.ts';
import { openNew, resumeSession } from './actions.ts';
import { Check, Chev, GLYPH, Glyph, ago, baseName, tilde } from './bits.tsx';
import { HistIcon } from './SessionMenu.tsx';
import { Robot } from './robot.tsx';
import { WidgetButton } from './widgets/WidgetButton.tsx';

const FolderIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" /></svg>
);

type Row = { cwd: string; here: boolean; right: React.ReactNode; needs?: boolean; sessions?: SessionSummary[] };

const subLabel = (r: SessionSummary) =>
  r.needsYou || r.state === 'waiting' ? 'needs you' : r.state === 'working' ? 'working' : r.state === 'done' ? 'done' : r.background ? 'agents running' : ago(r.lastActive);

// Folder chip with a popover: folders that have open sessions, a few recent ones, and the full picker.
export function FolderChip({ folder }: { folder: string }) {
  const roster = useStore((s) => s.roster);
  const past = useStore((s) => s.past);
  const home = useStore((s) => s.home);
  const current = useStore((s) => s.current);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // A folder opens inside the menu, so the reader picks the session (or makes one a widget) instead of jumping to its latest.
  const [into, setInto] = useState<string | null>(null);

  useEffect(() => {
    if (into) popRef.current?.querySelector<HTMLElement>('.fr.ss, .fr.fnew')?.focus({ preventScroll: true });
  }, [into]);

  useEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    const onBefore = (e: Event) => {
      const on = (e as ToggleEvent).newState === 'open';
      setOpen(on);
      if (!on) setInto(null);
      const r = btnRef.current?.getBoundingClientRect();
      if (!on || !r) return;
      pop.style.left = Math.max(12, r.left - 3) + 'px';
      pop.style.top = r.bottom + 11 + 'px';
    };
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'open') pop.querySelector<HTMLElement>('.fr.here, .fr')?.focus({ preventScroll: true });
    };
    pop.addEventListener('beforetoggle', onBefore);
    pop.addEventListener('toggle', onToggle);
    return () => {
      pop.removeEventListener('beforetoggle', onBefore);
      pop.removeEventListener('toggle', onToggle);
    };
  }, []);

  const groups = new Map<string, typeof roster>();
  for (const r of roster) groups.set(r.cwd, [...(groups.get(r.cwd) ?? []), r]);
  const openRows: Row[] = [...groups.entries()]
    .sort((a, b) => Number(b[0] === folder) - Number(a[0] === folder) || Math.max(...b[1].map((r) => r.lastActive)) - Math.max(...a[1].map((r) => r.lastActive)))
    .map(([cwd, rs]) => {
      const here = cwd === folder;
      const needs = rs.some((r) => r.needsYou || r.state === 'waiting');
      const working = rs.some((r) => r.state === 'working');
      const background = rs.some((r) => r.background);
      const right = needs ? (
        <><Glyph state="waiting" />needs you</>
      ) : working ? (
        <><Robot size={GLYPH} state="think" />working</>
      ) : background ? (
        <><Robot size={GLYPH} state="delegating" />agents running</>
      ) : (
        <>{rs.length} open</>
      );
      return { cwd, here, right, needs, sessions: rs.toSorted((a, b) => b.lastActive - a.lastActive) };
    });

  const openIds = new Set(roster.map((r) => r.id));
  const latest = new Map<string, number>();
  for (const p of past) if (!p.archived && !openIds.has(p.id) && !groups.has(p.cwd)) latest.set(p.cwd, Math.max(latest.get(p.cwd) ?? 0, p.lastModified));
  const recentRows: Row[] = [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cwd, at]) => ({ cwd, here: cwd === folder, right: <>{ago(at)}</> }));

  const elsewhere = roster.some((r) => r.cwd !== folder && (r.needsYou || r.state === 'waiting'));
  // Work still running in another folder is easy to forget, so the chip says so too.
  const busy = !elsewhere && roster.some((r) => r.cwd !== folder && (r.state === 'working' || r.background));
  const busyMain = busy && roster.some((r) => r.cwd !== folder && r.state === 'working');

  const hide = () => popRef.current?.hidePopover();
  const go = (cwd: string) => setInto(cwd);
  const pick = (id: string) => {
    hide();
    if (id !== current) openSession(id);
  };
  const intoOpen = into ? (groups.get(into) ?? []).toSorted((a, b) => b.lastActive - a.lastActive) : [];
  const intoPast = into ? past.filter((p) => p.cwd === into && !p.archived && !openIds.has(p.id)).sort((a, b) => b.lastModified - a.lastModified) : [];
  const back = () => {
    const was = into;
    setInto(null);
    if (was) requestAnimationFrame(() => popRef.current?.querySelector<HTMLElement>(`.fr[data-cwd="${CSS.escape(was)}"]`)?.focus());
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (into && (e.key === 'ArrowLeft' || e.key === 'Backspace')) {
      e.preventDefault();
      return back();
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = [...(popRef.current?.querySelectorAll<HTMLElement>('.fr') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };

  const render = (r: Row) => (
    <button key={r.cwd} type="button" role="menuitem" data-cwd={r.cwd} className={`fr${r.here ? ' here' : ''}${r.needs ? ' needs' : ''}`} aria-current={r.here || undefined} onClick={() => go(r.cwd)}>
      <FolderIcon />
      <span className="fn">{baseName(r.cwd)}</span>
      <span className="fp">{tilde(r.cwd, home)}</span>
      <span className="fs">{r.right}</span>
      <span className="fck" aria-hidden="true">{r.here && <Check />}</span>
    </button>
  );

  return (
    <>
      <button
        type="button" ref={btnRef} className="tab fchip-tab" popoverTarget="folderPop" aria-haspopup="menu" aria-expanded={open}
        data-open={open ? '' : undefined} title={tilde(folder, home)}
      >
        <FolderIcon /><span className="fnm">{baseName(folder)}</span><Chev />
        {(elsewhere || busy) && (
          <span className="fled" role="img" aria-label={elsewhere ? 'Another folder needs you' : 'Work is running in another folder'}>
            <Robot size={GLYPH} state={elsewhere ? 'needs' : busyMain ? 'think' : 'delegating'} />
          </span>
        )}
      </button>
      <div className="pop fpop" id="folderPop" popover="auto" ref={popRef} role="menu" aria-label={into ? `Sessions in ${baseName(into)}` : 'Folders'} onKeyDown={onKeyDown}>
        {into ? (
          <>
            <button type="button" role="menuitem" className="fr fback" aria-label="Back to folders" onClick={back}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.5 3.5 5 7l3.5 3.5" /></svg>
              <span className="fn">{baseName(into)}</span>
              <span className="fp">{tilde(into, home)}</span>
            </button>
            {intoOpen.length > 0 && <div className="pg"><span>Open sessions</span></div>}
            {intoOpen.map((r) => (
              <div key={r.id} className="frw">
                <button type="button" role="menuitem" className={`fr ss${r.needsYou ? ' needs' : ''}`} title={r.name} aria-current={r.id === current || undefined} onClick={() => pick(r.id)}>
                  <Glyph state={r.state} background={r.background} />
                  <span className="fn">{r.name}</span>
                  <span className="fs">{r.needsYou ? 'needs you' : r.state === 'working' ? 'working' : ago(r.lastActive)}</span>
                  <span className="fck" aria-hidden="true">{r.id === current && <Check />}</span>
                </button>
                <WidgetButton id={r.id} open className="fwg" onDone={hide} />
              </div>
            ))}
            {intoPast.length > 0 && <div className="pg"><span>Recent sessions</span></div>}
            {intoPast.slice(0, 5).map((p) => (
              <div key={p.id} className="frw">
                <button type="button" role="menuitem" className="fr ss" title={p.name} onClick={() => { hide(); resumeSession(p.id); }}>
                  <HistIcon />
                  <span className="fn">{p.name}</span>
                  <span className="fs">{ago(p.lastModified)}</span>
                </button>
                <WidgetButton id={p.id} open={false} className="fwg" onDone={hide} />
              </div>
            ))}
            <div className="sep"></div>
            <button type="button" role="menuitem" className="fr fnew" onClick={() => { hide(); openNew(into); }}>
              <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              <span className="fn">New session here</span>
            </button>
            {intoPast.length > 5 && (
              <button type="button" role="menuitem" className="fr fall" onClick={() => { hide(); setPalette('switch', into); }}>
                <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M2 3.5h9M2 6.5h9M2 9.5h6" /></svg>
                <span className="fn">All {intoPast.length} sessions…</span>
              </button>
            )}
          </>
        ) : (
          <>
            {openRows.length > 0 && <div className="pg"><span>Open sessions</span></div>}
            {openRows.map((row) => (
              <Fragment key={row.cwd}>
                {render(row)}
                {row.sessions?.map((r) => {
                  const need = r.needsYou || r.state === 'waiting';
                  return (
                    <button
                      key={r.id} type="button" role="menuitem" title={r.name} aria-current={r.id === current || undefined} onClick={() => pick(r.id)}
                      className={`fr ss fsub${need ? ' needs' : r.state === 'done' ? ' done' : ''}`}
                    >
                      <Glyph state={r.state} background={r.background} />
                      <span className="fn">{r.name}</span>
                      <span className="fs">{subLabel(r)}</span>
                      <span className="fck" aria-hidden="true">{r.id === current && <Check />}</span>
                    </button>
                  );
                })}
              </Fragment>
            ))}
            {recentRows.length > 0 && <div className="pg"><span>Recent</span></div>}
            {recentRows.map(render)}
            <div className="sep"></div>
            <button type="button" role="menuitem" className="fr fall" onClick={() => { hide(); setPalette('folder'); }}>
              <FolderIcon />
              <span className="fn">All folders…</span>
              <span className="fs"><kbd>alt N</kbd></span>
            </button>
          </>
        )}
      </div>
    </>
  );
}
