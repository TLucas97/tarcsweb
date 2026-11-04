import { Suspense, lazy, useEffect, useRef, useState, type MouseEvent } from 'react';
import { currentSummary, useStore } from './store.ts';
import { showStart } from './socket.ts';
import { CallIcon, Chev, HomeIcon, PowerIcon } from './bits.tsx';
import { roveMenu } from './Menus.tsx';
import { FindIcon, openFind } from './Find.tsx';
import { FolderIcon, openFiles, prefetchFiles } from './FileTree.tsx';
import { BrowserIcon, toggleBrowser, useBrowserState } from './browser/Entry.tsx';
import { WatchIcon, setWatch, useWatchable } from './watch/Entry.tsx';
import { GearIcon, SettingsHost, openSettings, warmSettings } from './SettingsEntry.tsx';
import { useSetup } from './setup.ts';
import { setCallFull, startCall, useCallActive } from './call.ts';

const QuitDialog = lazy(() => import('./QuitDialog.tsx'));

// The header's tools as one menu beside the session name. Rows close it first, so panels and dialogs grow out of its button.
// The tools used mid-task, as icons at the top right.
export function HeaderActions() {
  const summary = useStore(currentSummary);
  const watchable = useWatchable();
  const brw = useBrowserState();
  // Unknown until something asks Codex, so only a known sign-out hides the call; starting one checks the sign-in.
  const codexIn = useSetup((s) => s.codex?.signedIn !== false);
  const calling = useCallActive();
  const run = (fn: (from: HTMLElement) => void) => (e: MouseEvent<HTMLButtonElement>) => fn(e.currentTarget);
  return (
    <div className="hdr-acts" role="toolbar" aria-label="Session tools">
      {summary && (
        <>
          <button type="button" aria-label="Find in conversation" title="Find in conversation (Ctrl F)" onClick={openFind}><FindIcon /></button>
          <button type="button" aria-label="Browse files" title="Browse files" onPointerEnter={prefetchFiles} onClick={run(openFiles)}><FolderIcon /></button>
        </>
      )}
      {/* During a call it brings the call back full screen, whichever session is open. */}
      {summary && codexIn && (
        <button
          type="button" aria-label={calling ? 'Show the voice call' : 'Voice call with Codex'}
          title={calling ? 'Show the call full screen' : 'Voice call with Codex about this session'}
          onClick={() => (calling ? setCallFull(true) : void startCall(summary.id, summary.name))}
        >
          <CallIcon />
          {calling && <i className="mcp-dot" aria-hidden="true" />}
        </button>
      )}
      <button type="button" aria-label="Browser" title={brw.title} aria-pressed={brw.going} onClick={run(toggleBrowser)}>
        <BrowserIcon />{brw.going && <i className={`mcp-dot${brw.live ? '' : ' wait'}`} aria-label={brw.live ? 'running' : 'starting'} />}
      </button>
      {summary && watchable && <button type="button" aria-label="Watch" title="Watch" onClick={run((from) => setWatch(true, from))}><WatchIcon /></button>}
    </div>
  );
}

export function HeaderMenu() {
  const summary = useStore(currentSummary);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const stopped = useStore((s) => s.quit !== null);

  useEffect(() => {
    const p = pop.current!;
    const place = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open') return;
      const r = btn.current!.getBoundingClientRect();
      // 240px menu centred under the button, kept 12px inside the window.
      p.style.left = Math.max(12, Math.min(r.left + r.width / 2 - 120, innerWidth - 252)) + 'px';
      p.style.top = r.bottom + 8 + 'px';
    };
    const toggled = (e: Event) => setOpen((e as ToggleEvent).newState === 'open');
    p.addEventListener('beforetoggle', place);
    p.addEventListener('toggle', toggled);
    return () => {
      p.removeEventListener('beforetoggle', place);
      p.removeEventListener('toggle', toggled);
    };
  }, []);

  const act = (fn: (from: HTMLElement) => void) => () => {
    pop.current!.hidePopover();
    fn(btn.current!);
  };

  return (
    <>
      <button
        ref={btn} type="button" className="fnd-open hm-open" popoverTarget="hdrPop" aria-haspopup="menu" aria-expanded={open} aria-label="Session tools" title="Tools"
        onPointerEnter={warmSettings}
      >
        <Chev />
      </button>
      <div className="pop mpop ctx hm-pop" id="hdrPop" popover="auto" ref={pop} role="menu" aria-label="Session tools" onKeyDown={roveMenu}>
        {summary && <button className="mi" role="menuitem" onClick={act(showStart)}><span className="nm2"><HomeIcon />Back to Start</span><i className="hm-dot" /></button>}
        <button className="mi" role="menuitem" onClick={act(openSettings)}><span className="nm2"><GearIcon />Settings</span><i className="hm-dot" /></button>
        <button className="mi hm-quit" role="menuitem" onClick={act(() => setQuitting(true))}><span className="nm2"><PowerIcon />Quit tarcsweb…</span><i className="hm-dot" /></button>
      </div>
      <SettingsHost origin={btn} />
      {quitting && !stopped && <Suspense fallback={null}><QuitDialog onClose={() => setQuitting(false)} /></Suspense>}
    </>
  );
}
