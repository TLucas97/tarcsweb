import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLayoutVars } from '../layoutVars.ts';
import { MenuList, type MenuApi } from '../MenuList.tsx';
import { useStore } from '../store.ts';
import type { MentionEntry } from '../../../server/protocol.ts';
import { askMentions } from './ask.ts';
import { mentionOf } from './token.tsx';

const SHOWN_MAX = 100;
const FIND_DELAY_MS = 80;
// Folders listed while one menu stays open; the oldest drop off.
const LISTS_MAX = 30;

type Tok = { start: number; end: number; quoted: boolean; query: string };
type ListState = { entries: MentionEntry[]; base: string; more: boolean } | { error: string } | 'loading';
type Found = { query: string; entries: MentionEntry[]; more: boolean; error?: string };
type Row = { entry: MentionEntry; self?: true };
// find: fuzzy over the session folder. list: one folder, like shell completion, once the query has a slash or starts with ~.
type Ask = { kind: 'find'; query: string } | { kind: 'list'; dir: string; filter: string };

// The @token around the caret, at the start or after whitespace; '@"' opens a quoted path that may hold spaces.
function tokenAt(t: HTMLTextAreaElement): Tok | null {
  const v = t.value;
  const c = t.selectionStart;
  if (c !== t.selectionEnd) return null;
  const m = /(^|\s)@("[^"\n]*|[^\s"]*)$/.exec(v.slice(0, c));
  if (!m) return null;
  const start = m.index + m[1].length;
  const quoted = m[2].startsWith('"');
  const rest = v.slice(c);
  let end = c;
  if (quoted) end += /^[^"\n@]*"/.exec(rest)?.[0].length ?? 0;
  else {
    const ws = rest.search(/\s/);
    end = ws < 0 ? v.length : c + ws;
  }
  return { start, end, quoted, query: m[2].slice(quoted ? 1 : 0) };
}

function askOf(query: string): Ask {
  if (query === '~') return { kind: 'list', dir: '~/', filter: '' };
  const slash = query.lastIndexOf('/');
  if (slash < 0) return query ? { kind: 'find', query } : { kind: 'list', dir: '', filter: '' };
  return { kind: 'list', dir: query.slice(0, slash + 1), filter: query.slice(slash + 1) };
}

const parentOf = (path: string) => {
  const p = path.replace(/\/$/, '');
  return p.slice(0, p.lastIndexOf('/') + 1);
};

export const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.8 4.2a1.2 1.2 0 0 1 1.2-1.2h3.2l1.4 1.6H13a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z" />
  </svg>
);
export const FileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 1.8h5.6l3.4 3.4v9H3.5zM9 1.8v3.6h3.5" />
  </svg>
);

// Replaces a span of the prompt, undoable like typing; the input event lets the composer and the menus catch up.
function replace(t: HTMLTextAreaElement, start: number, end: number, text: string) {
  t.focus();
  t.setSelectionRange(start, end);
  if (document.execCommand('insertText', false, text)) return;
  t.setRangeText(text, start, end, 'end');
  t.dispatchEvent(new Event('input', { bubbles: true }));
}

// The composer's @ menu: files and folders of the session folder, or any folder by path ("@~/", "@/", "@src/").
export function useMention(promptRef: RefObject<HTMLTextAreaElement | null>) {
  const current = useStore((s) => s.current);
  const [tok, setTok] = useState<Tok | null>(null);
  const [lists, setLists] = useState<Record<string, ListState>>({});
  const [found, setFound] = useState<Found | null>(null);
  const asked = useRef(new Set<string>());
  const latest = useRef('');
  const timer = useRef(0);
  const popRef = useRef<HTMLDivElement>(null);
  const popEl = useLayoutVars(popRef);
  const listApi = useRef<MenuApi>(null);

  const ask = tok ? askOf(tok.query) : null;

  const close = () => {
    clearTimeout(timer.current);
    setTok(null);
    setLists({});
    setFound(null);
    asked.current.clear();
  };

  const fetchList = (sid: string, dir: string) => {
    if (asked.current.has(dir)) return;
    asked.current.add(dir);
    setLists((l) => ({ ...l, [dir]: 'loading' }));
    void askMentions({ type: 'mention-list', sessionId: sid, path: dir }).then((r) => {
      if (useStore.getState().current !== sid) return;
      const st: ListState = !r ? { error: 'No answer from the server' } : r.error ? { error: r.error } : { entries: r.entries, base: r.base ?? dir, more: r.more };
      setLists((l) => {
        const keys = Object.keys(l).filter((k) => k !== dir);
        const kept = Object.fromEntries(keys.slice(Math.max(0, keys.length - LISTS_MAX + 1)).map((k) => [k, l[k]]));
        return { ...kept, [dir]: st };
      });
    });
  };

  const fetchFind = (sid: string, query: string) => {
    latest.current = query;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void askMentions({ type: 'mention-find', sessionId: sid, query }).then((r) => {
        if (useStore.getState().current !== sid || latest.current !== query) return;
        setFound({ query, entries: r?.entries ?? [], more: !!r?.more, ...(r ? (r.error ? { error: r.error } : {}) : { error: 'No answer from the server' }) });
      });
    }, FIND_DELAY_MS);
  };

  // Called on every prompt input: opens, follows or closes the menu.
  const onInput = () => {
    const t = promptRef.current;
    const k = t && current ? tokenAt(t) : null;
    if (!k || !current) return void (tok && close());
    const a = askOf(k.query);
    if (a.kind === 'list') fetchList(current, a.dir);
    else fetchFind(current, a.query);
    setTok(k);
  };

  let rows: Row[] = [];
  let status: string | null = null;
  let more = false;
  if (ask?.kind === 'list') {
    const st = lists[ask.dir];
    if (!st || st === 'loading') status = 'Loading…';
    else if ('error' in st) status = st.error;
    else {
      const f = ask.filter.toLowerCase();
      // Dot entries stay hidden until the filter starts with a dot, as in a shell.
      const vis = st.entries.filter((e) => f.startsWith('.') || !e.name.startsWith('.'));
      const low = (e: MentionEntry) => e.name.toLowerCase();
      const hits = [...vis.filter((e) => low(e).startsWith(f)), ...(f ? vis.filter((e) => !low(e).startsWith(f) && low(e).includes(f)) : [])];
      rows = [
        ...(ask.dir && !f && st.base ? [{ entry: { name: st.base, path: st.base, dir: true }, self: true as const }] : []),
        ...hits.slice(0, SHOWN_MAX).map((entry) => ({ entry })),
      ];
      more = st.more || hits.length > SHOWN_MAX;
      if (!hits.length) status = f ? 'Nothing here matches' : 'Empty folder';
    }
  } else if (ask?.kind === 'find') {
    if (found?.error) status = found.error;
    else if (found) {
      rows = found.entries.map((entry) => ({ entry }));
      more = found.more;
    }
    if (!rows.length && !status) status = found?.query === ask.query ? 'No file or folder matches' : 'Searching…';
  }
  // Goes into a folder: the token becomes its path and the menu lists it.
  const descend = (path: string) => {
    const t = promptRef.current;
    const k = t && tokenAt(t);
    if (!t || !k) return;
    replace(t, k.start, k.end, `@${k.quoted || /[\s"]/.test(path) ? `"${path}` : path}`);
  };

  const insert = (path: string) => {
    const t = promptRef.current;
    const k = t && tokenAt(t);
    if (!t || !k) return;
    close();
    replace(t, k.start, k.end, `${mentionOf(path)} `);
  };

  // Browsing a folder, a click on a subfolder opens it; in search results it is the pick. Tab always opens.
  const choose = (row: Row, tab = false) => {
    const e = row.entry;
    if (!e.dir || row.self) return insert(e.path);
    if (ask?.kind === 'list' || tab) return descend(e.path);
    insert(e.path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!tok || e.nativeEvent.isComposing) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return true;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      listApi.current?.move(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    const row = rows[listApi.current?.at() ?? 0];
    if (!row || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      choose(row, e.key === 'Tab');
      return true;
    }
    return false;
  };

  // Placed above the composer like the slash menu, reading layout only when it opens.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    if (!tok) {
      if (pop.matches(':popover-open')) pop.hidePopover();
      return;
    }
    if (pop.matches(':popover-open')) return;
    const form = promptRef.current?.closest('form');
    if (form) {
      const r = form.getBoundingClientRect();
      pop.style.left = `${r.left}px`;
      pop.style.width = `${Math.min(560, r.width)}px`;
    }
    pop.showPopover();
  });

  // A click anywhere but the menu or the prompt closes it.
  useEffect(() => {
    if (!tok) return;
    const down = (e: PointerEvent) => {
      const n = e.target as Node;
      if (popRef.current?.contains(n) || n === promptRef.current) return;
      close();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [tok !== null, promptRef]);

  useEffect(() => close, [current]);

  const renderRow = (i: number, selected: boolean) => {
    const row = rows[i];
    const e = row.entry;
    return (
      <button
        type="button" tabIndex={-1} role="option" aria-selected={selected} className={`sl-row mn-row${row.self ? ' self' : ''}`} data-i={i}
        onMouseDown={(ev) => ev.preventDefault()} onClick={() => choose(row)}
      >
        <span className="mn-nm">
          {e.dir ? <FolderIcon /> : <FileIcon />}
          {row.self ? <span>Use this folder</span> : <span>{e.name}{e.dir ? '/' : ''}</span>}
        </span>
        {e.dir && !row.self && (
          ask?.kind === 'find'
            ? <span role="button" className="mn-open" title="Open folder" aria-label={`Open ${e.name}`} onClick={(ev) => { ev.stopPropagation(); descend(e.path); }}>›</span>
            : <span className="mn-open" aria-hidden="true">›</span>
        )}
        {(row.self || ask?.kind === 'find') && <small>{row.self ? e.path : parentOf(e.path) || './'}</small>}
      </button>
    );
  };

  const head = ask?.kind === 'list' ? (ask.dir || 'Session folder') : 'Files and folders';
  const panel = createPortal(
    <div className="sl-pop mn-pop" popover="manual" ref={popEl} aria-label="Mention a file or folder">
      <div className="sl-head"><span className="mn-head">{head}</span><span><kbd>↵</kbd> pick · <kbd>⇥</kbd> open folder · <kbd>esc</kbd> close</span></div>
      <MenuList count={rows.length} reset={tok?.query ?? ''} api={listApi} keyOf={(i) => (rows[i].self ? '.' : rows[i].entry.path)} render={renderRow}>
        {status && <div className="sl-empty">{status}</div>}
        {more && !status && <div className="sl-empty">More results: type more to narrow them</div>}
      </MenuList>
    </div>,
    document.body,
  );

  return { onInput, onKeyDown, panel };
}
