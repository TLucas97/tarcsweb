import { useEffect, useId, useRef, useState } from 'react';
import type { SessionSummary, Settings } from '../../server/protocol.ts';
import { send } from './socket.ts';
import { useStore } from './store.ts';
import { Check, Chev, baseName, tilde } from './bits.tsx';
import { FolderIcon } from './DockFolders.tsx';
import { ModelMenu, roveMenu } from './Menus.tsx';

const FOUND_MAX = 8;
const isPath = (q: string) => q.startsWith('/') || q.startsWith('~');

// The source's folder, recent folders and a search under home, as the palette does; a typed path is offered as is.
function FolderPick({ labelledBy, value, source, onPick }: { labelledBy: string; value: string; source: string; onPick: (path: string) => void }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const home = useStore((s) => s.home);
  const recent = useStore((s) => s.folders);
  const found = useStore((s) => s.found);
  const q = query.trim();
  const search = open && q.length >= 2 && !isPath(q) ? q : '';
  useEffect(() => {
    if (!search) return;
    const t = setTimeout(() => send({ type: 'find-dirs', query: search }), 180);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    const p = pop.current!;
    const place = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open') return;
      const r = btn.current!.getBoundingClientRect();
      p.style.left = `${r.left}px`;
      p.style.top = `${r.bottom + 6}px`;
      p.style.width = `${r.width}px`;
      p.style.maxHeight = `${Math.min(380, innerHeight - r.bottom - 18)}px`;
    };
    const toggled = (e: Event) => {
      const on = (e as ToggleEvent).newState === 'open';
      setOpen(on);
      setQuery('');
      if (on) input.current!.focus({ preventScroll: true });
    };
    p.addEventListener('beforetoggle', place);
    p.addEventListener('toggle', toggled);
    return () => {
      p.removeEventListener('beforetoggle', place);
      p.removeEventListener('toggle', toggled);
    };
  }, []);
  const low = q.toLowerCase();
  const has = (p: string) => !low || p.toLowerCase().includes(low);
  const recentRows = recent.map((f) => f.path).filter((p) => p !== source && has(p));
  const hits = search && found?.query === search ? found.dirs.map((d) => d.path).filter((p) => p !== source && !recentRows.includes(p)).slice(0, FOUND_MAX) : [];
  const groups: [string, string[]][] = [['Typed path', isPath(q) ? [q] : []], ['This session', has(source) ? [source] : []], ['Recent', recentRows], ['Found in home', hits]];
  const first = groups.find((g) => g[1].length)?.[1][0];
  const pick = (path: string) => {
    pop.current!.hidePopover();
    onPick(path);
  };
  return (
    <>
      <button ref={btn} type="button" className="set-fp ssd-fp" popoverTarget={id} aria-haspopup="menu" aria-expanded={open} aria-labelledby={`${labelledBy} ${id}-v`}>
        <span id={`${id}-v`}><FolderIcon /><b>{baseName(value)}</b><small className="mono">{tilde(value, home)}</small></span><Chev />
      </button>
      <div
        className="pop mpop ctx set-fpop ssd-fpop" id={id} popover="auto" ref={pop} role="menu" aria-labelledby={labelledBy}
        onKeyDown={(e) => (e.target !== input.current || e.key.startsWith('Arrow')) && roveMenu(e)}
      >
        <div className="ssd-qw">
          <input
            ref={input} className="set-in" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search folders or type a path"
            aria-label="Search folders or type a path" spellCheck={false} autoComplete="off" maxLength={4096}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (first) pick(first);
            }}
          />
        </div>
        {groups.map(([section, paths]) => paths.length > 0 && (
          <div key={section} role="group" aria-label={section}>
            <div className="pg" role="presentation"><span>{section}</span></div>
            {paths.map((p) => (
              <button key={p} type="button" className="mi" role="menuitemradio" aria-checked={p === value} onClick={() => pick(p)}>
                <span className="nm2"><FolderIcon />{section === 'Typed path' ? 'Use this path' : baseName(p)}</span>
                <small className="mono">{tilde(p, home)}</small>
                <span className="side"><span className="ck"><Check /></span></span>
              </button>
            ))}
          </div>
        ))}
        {!first && <p className="mnote">{search && found?.query !== search ? 'Searching…' : 'No folder matches'}</p>}
      </div>
    </>
  );
}

// Mount on demand from the sidebar; key by source.id so a new parent starts a fresh form.
export default function SubsessionDialog({ source, onClose }: { source: SessionSummary; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const sw = useId();
  const folderLabel = useId();
  const modelLabel = useId();
  const modelPop = useId();
  const [folder, setFolder] = useState(source.cwd);
  const [worktree, setWorktree] = useState(true);
  const [instruction, setInstruction] = useState('');
  const [settings, setSettings] = useState<Settings>({ mode: source.mode, model: source.model, effort: source.effort });
  const [error, setError] = useState('');
  // The server always gives it its own worktree when an open session already uses the repository; the same folder is the case known here.
  const roster = useStore((s) => s.roster);
  const sharer = roster.find((r) => r.cwd === folder && r.branch !== null)?.name;
  const child = source.group && source.group.mainId !== source.id;
  const ready = !child && !!instruction.trim();
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  // The new row shows the handoff being written; a failure comes back as the app's notice.
  return <dialog ref={dialog} className="pal sub-session-dialog" aria-labelledby={title} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <form className="ssd" onSubmit={(e) => {
      e.preventDefault();
      if (!ready) return;
      // Codex writes the handoff only from an idle thread; the server refuses too, but only after this dialog closed.
      const now = roster.find((r) => r.id === source.id) ?? source;
      if (now.provider === 'codex' && !now.fresh && now.state !== 'idle' && now.state !== 'done') return setError('This session is busy. Try again when its turn ends.');
      if (!send({ type: 'group-open', sessionId: source.id, folder, worktree: !!sharer || worktree, instruction: instruction.trim(), model: settings.model, effort: settings.effort })) {
        return setError('Not connected. Try again when the connection returns.');
      }
      onClose();
    }}>
      <h2 id={title}>New sub-session</h2>
      <p className="set-hint">
        {source.fresh ? 'This session has no conversation yet, so it starts with your task and the group\'s shared summary.' : 'It starts with a handoff written from this session\'s conversation, your task and the group\'s shared summary.'} The main session merges the results.
      </p>
      <fieldset className="ssd-fs">
        <div className="set-fl"><span id={folderLabel}>Folder</span><FolderPick labelledBy={folderLabel} value={folder} source={source.cwd} onPick={setFolder} /></div>
        <div className="set-swrow">
          <div className="set-l">
            <label htmlFor={sw}>Use a separate worktree</label>
            <small id={`${sw}-h`}>{sharer ? `Required while ${sharer} is open in this repository` : 'Used anyway if an open session already works in this repository'}</small>
          </div>
          <button
            id={sw} type="button" role="switch" className="set-sw" aria-checked={!!sharer || worktree} disabled={!!sharer} aria-describedby={`${sw}-h`}
            onClick={() => setWorktree(!worktree)}
          >
            <i></i>
          </button>
        </div>
        <label className="set-fl">
          <span>Task</span>
          <textarea
            className="set-in" value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={16000} required autoFocus placeholder="What should this sub-session do?"
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.currentTarget.form!.requestSubmit()}
          />
        </label>
        <div className="set-swrow">
          <div className="set-l"><span id={modelLabel}>Model</span><small>Defaults to this session's model</small></div>
          <div role="group" aria-labelledby={modelLabel}>
            <ModelMenu own={{ id: modelPop, value: settings, set: (patch) => setSettings((s) => ({ ...s, ...patch })) }} />
          </div>
        </div>
      </fieldset>
      {child && <p className="set-err" role="alert">Sub-sessions cannot create sub-sessions.</p>}
      {error && <p className="set-err" role="alert">{error}</p>}
      <div className="ssd-acts">
        <button type="button" className="set-clear" onClick={onClose}>Cancel</button>
        <button type="submit" className="set-btn" disabled={!ready}>Open sub-session</button>
      </div>
    </form>
  </dialog>;
}
