import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { MentionEntry } from '../../../server/protocol.ts';
import { askMentions } from './ask.ts';
import { FileIcon, FolderIcon } from './useMention.tsx';

type Listing = { abs: string; base: string; entries: MentionEntry[]; more: boolean } | { error: string } | null;

const UpIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" /></svg>
);

// "Reference file or folder": browses folders through the server, so any file type or folder can be picked by path.
// Picks survive moving between folders; onPick gets mention paths (relative inside the session folder).
export default function Picker({ sessionId, anchor, onPick, onClose }: {
  sessionId: string; anchor: RefObject<HTMLElement | null>; onPick: (paths: string[]) => void; onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<Listing>(null);
  const [field, setField] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<MentionEntry[]>([]);
  const seq = useRef(0);

  const go = (path: string) => {
    const n = ++seq.current;
    setList(null);
    setFilter('');
    void askMentions({ type: 'mention-list', sessionId, path }).then((r) => {
      if (n !== seq.current) return;
      if (!r || r.error || r.abs === undefined) return setList({ error: r?.error ?? 'No answer from the server' });
      setList({ abs: r.abs, base: r.base ?? '', entries: r.entries, more: r.more });
      setField(r.abs);
    });
  };

  useEffect(() => go(''), [sessionId]);

  // Opens above the composer with its right edge on the button's; layout is read only when it opens.
  useEffect(() => {
    const pop = popRef.current!;
    const place = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open') return;
      const r = (anchor.current ?? document.body).getBoundingClientRect();
      const top = (anchor.current?.closest('form') ?? anchor.current ?? document.body).getBoundingClientRect().top;
      const w = Math.min(560, innerWidth - 24);
      pop.style.width = `${w}px`;
      pop.style.left = `${Math.max(12, Math.min(r.right - w, innerWidth - w - 12))}px`;
      pop.style.bottom = `${innerHeight - top + 8}px`;
    };
    const toggled = (e: Event) => (e as ToggleEvent).newState === 'closed' && onClose();
    pop.addEventListener('beforetoggle', place);
    pop.addEventListener('toggle', toggled);
    pop.showPopover();
    return () => {
      pop.removeEventListener('beforetoggle', place);
      pop.removeEventListener('toggle', toggled);
    };
  }, []);

  const isPicked = (e: MentionEntry) => picked.some((p) => p.path === e.path);
  const toggle = (e: MentionEntry) => setPicked((ps) => (ps.some((p) => p.path === e.path) ? ps.filter((p) => p.path !== e.path) : [...ps, e]));
  const done = () => {
    const paths = picked.map((p) => p.path);
    popRef.current?.hidePopover();
    if (paths.length) onPick(paths);
  };

  const ok = list && !('error' in list) ? list : null;
  const f = filter.trim().toLowerCase();
  const rows = ok ? ok.entries.filter((e) => (f.startsWith('.') || !e.name.startsWith('.')) && (!f || e.name.toLowerCase().includes(f))) : [];
  const hidden = ok ? ok.entries.length - rows.length : 0;

  return createPortal(
    <div className="pop mnp" popover="auto" ref={popRef} role="dialog" aria-label="Reference files or folders">
      <div className="mnp-bar">
        <button type="button" className="mnp-btn" title="Up one folder" aria-label="Up one folder" disabled={!ok || ok.abs === '/'} onClick={() => ok && go(`${ok.abs}/..`)}><UpIcon /></button>
        <input
          className="mnp-path" value={field} aria-label="Folder path" spellCheck={false} autoComplete="off" placeholder="Path, like ~/projects or /etc"
          onChange={(e) => setField(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            go(field);
          }}
        />
        <button type="button" className="mnp-btn txt" title="The session folder" onClick={() => go('')}>Session</button>
        <button type="button" className="mnp-btn txt" title="Your home folder" onClick={() => go('~')}>Home</button>
      </div>
      <input className="mnp-filter" value={filter} placeholder="Filter (start with . for hidden files)" aria-label="Filter" spellCheck={false} autoComplete="off" onChange={(e) => setFilter(e.currentTarget.value)} />
      <div className="mnp-list" role="listbox" aria-multiselectable="true" aria-label="Files and folders">
        {!list && <div className="sl-empty">Loading…</div>}
        {list && 'error' in list && <div className="sl-empty">{list.error}</div>}
        {ok && !rows.length && <div className="sl-empty">{f ? 'Nothing here matches' : 'Empty folder'}</div>}
        {rows.map((e) => (
          <div key={e.path} className="mnp-row" role="option" aria-selected={isPicked(e)} onDoubleClick={() => e.dir && go(`${ok!.abs}/${e.name}`)}>
            <label>
              <input type="checkbox" checked={isPicked(e)} onChange={() => toggle(e)} />
              {e.dir ? <FolderIcon /> : <FileIcon />}
              <span className="mnp-nm">{e.name}{e.dir ? '/' : ''}</span>
            </label>
            {e.dir && <button type="button" className="mnp-open" title={`Open ${e.name}`} aria-label={`Open ${e.name}`} onClick={() => go(`${ok!.abs}/${e.name}`)}>›</button>}
          </div>
        ))}
        {ok && (ok.more || hidden > 0) && <div className="sl-empty">{ok.more ? 'Long folder: only the first entries show. ' : ''}{hidden > 0 ? `${hidden} hidden by the filter or as dot files` : ''}</div>}
      </div>
      <div className="mnp-foot">
        <span className="mnp-count" title={picked.map((p) => p.path).join('\n')}>{picked.length ? `${picked.length} selected` : 'Tick files or folders'}</span>
        {picked.length > 0 && <button type="button" className="mnp-btn txt" onClick={() => setPicked([])}>Clear</button>}
        <button type="button" className="mnp-btn txt" onClick={() => popRef.current?.hidePopover()}>Cancel</button>
        <button type="button" className="mnp-go" disabled={!picked.length} onClick={done}>Reference</button>
      </div>
    </div>,
    document.body,
  );
}
