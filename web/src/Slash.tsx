import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from './store.ts';
import type { SlashItem } from '../../server/protocol.ts';

type Mode = 'typed' | 'button' | null;
type Row = { item: SlashItem; group?: string };

// Name and aliases rank first, then description; an empty query lists built-ins, then skills.
function rank(list: SlashItem[], query: string): Row[] {
  const q = query.toLowerCase();
  const byName = (a: SlashItem, b: SlashItem) => a.name.localeCompare(b.name);
  if (!q) {
    const builtin = list.filter((c) => !c.skill).sort(byName);
    const skills = list.filter((c) => c.skill).sort(byName);
    return [
      ...builtin.map((item, i) => ({ item, ...(i === 0 ? { group: 'Built-in' } : {}) })),
      ...skills.map((item, i) => ({ item, ...(i === 0 ? { group: 'Skills' } : {}) })),
    ];
  }
  const score = (c: SlashItem) => {
    const n = c.name.toLowerCase();
    const tail = n.slice(n.indexOf(':') + 1);
    const al = (c.aliases ?? []).map((a) => a.toLowerCase());
    if (n === q || al.includes(q)) return 0;
    if (n.startsWith(q) || tail.startsWith(q)) return 1;
    if (al.some((a) => a.startsWith(q))) return 2;
    if (n.includes(q) || al.some((a) => a.includes(q))) return 3;
    return c.description.toLowerCase().includes(q) ? 4 : -1;
  };
  return list
    .map((item) => ({ item, s: score(item) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => a.s - b.s || Number(!!a.item.skill) - Number(!!b.item.skill) || byName(a.item, b.item))
    .map(({ item }) => ({ item }));
}

// The leading "/token" of the prompt: where it ends, and the query when the caret is inside it.
function token(t: HTMLTextAreaElement) {
  const v = t.value;
  const ws = v.search(/\s/);
  const end = ws < 0 ? v.length : ws;
  const inside = v.startsWith('/') && t.selectionStart === t.selectionEnd && t.selectionStart > 0 && t.selectionStart <= end;
  return { end, query: inside ? v.slice(1, end) : null };
}

const SlashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3" /><path d="M9.6 5 6.4 11" />
  </svg>
);

// The composer's /command menu: opened by typing "/" first, or by its button with a search field.
export function useSlash(promptRef: RefObject<HTMLTextAreaElement | null>) {
  const current = useStore((s) => s.current);
  const commands = useStore((s) => {
    const own = s.current ? s.commands?.[s.current] : undefined;
    return own?.length ? own : (s.lastCommands ?? []);
  });
  const [mode, setMode] = useState<Mode>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // The command at the start of the prompt while its arguments are still empty.
  const [arg, setArg] = useState<SlashItem | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = mode ? rank(commands, query) : [];
  const shown = mode === 'button' || (mode === 'typed' && rows.length > 0);
  const at = Math.min(active, Math.max(0, rows.length - 1));

  const close = () => setMode(null);

  const refreshArg = () => {
    const t = promptRef.current;
    const m = t ? /^\/(\S+)\s+$/.exec(t.value) : null;
    const item = m ? commands.find((c) => c.name === m[1]) : undefined;
    setArg(item?.hint ? item : null);
  };

  // Called on every prompt input: opens, filters or closes the typed menu.
  const onInput = () => {
    const t = promptRef.current;
    refreshArg();
    if (!t || mode === 'button') return;
    const { query: q } = token(t);
    if (q === null || !commands.length) return close();
    if (mode !== 'typed' || q !== query) setActive(0);
    setQuery(q);
    setMode('typed');
  };

  const insert = (item: SlashItem) => {
    const t = promptRef.current;
    if (!t) return;
    const v = t.value;
    const end = v.startsWith('/') ? token(t).end : 0;
    const spaces = /^[ \t]*/.exec(v.slice(end))![0].length;
    t.focus();
    t.setRangeText(`/${item.name} `, 0, end + spaces, 'end');
    setMode(null);
    // The composer's own input handler resizes the box and saves the draft.
    t.dispatchEvent(new Event('input', { bubbles: true }));
    setArg(item.hint ? item : null);
  };

  const move = (d: number) => rows.length && setActive((at + d + rows.length) % rows.length);

  // Shared by the prompt (typed mode) and the search field; true when the key was the menu's.
  const onKey = (e: KeyboardEvent, typed: boolean) => {
    if (e.nativeEvent.isComposing) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      if (!typed) promptRef.current?.focus();
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    const row = rows[at];
    if (!row || e.shiftKey || e.altKey) return false;
    if (e.key === 'Tab' || e.key === 'Enter') {
      // A fully typed name sends as is; Ctrl+Enter always sends.
      if (typed && e.key === 'Enter' && (e.ctrlKey || e.metaKey || query === row.item.name)) {
        close();
        return false;
      }
      e.preventDefault();
      e.stopPropagation();
      insert(row.item);
      return true;
    }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => (mode === 'typed' && shown ? onKey(e, true) : false);

  const toggle = () => {
    if (mode === 'button') return close();
    setQuery('');
    setActive(0);
    setMode('button');
  };

  // Placed above the composer, left-aligned to it; the top layer keeps it over the conversation.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    if (!shown) {
      if (pop.matches(':popover-open')) pop.hidePopover();
      return;
    }
    const form = promptRef.current?.closest('form');
    if (form) {
      const r = form.getBoundingClientRect();
      pop.style.left = `${r.left}px`;
      pop.style.bottom = `${innerHeight - r.top + 8}px`;
      pop.style.width = `${Math.min(560, r.width)}px`;
    }
    if (!pop.matches(':popover-open')) pop.showPopover();
    if (mode === 'button') searchRef.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, mode, query]);

  // A click anywhere else closes it; the prompt itself keeps the typed menu.
  useEffect(() => {
    if (!mode) return;
    const down = (e: PointerEvent) => {
      const n = e.target as Node;
      if (popRef.current?.contains(n) || btnRef.current?.contains(n) || (mode === 'typed' && n === promptRef.current)) return;
      setMode(null);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [mode, promptRef]);

  useEffect(() => {
    setMode(null);
    setArg(null);
  }, [current]);

  const button = (
    <button
      type="button" ref={btnRef} className="attach sl-btn" aria-label="Commands and skills" title="Commands and skills"
      aria-haspopup="listbox" aria-expanded={mode === 'button'} onClick={toggle}
    >
      <SlashIcon />
    </button>
  );

  const argHint = arg ? <span className="sl-arghint" aria-hidden="true">{arg.hint}</span> : null;

  const panel = createPortal(
    <div className="sl-pop" popover="manual" ref={popRef} aria-label="Commands and skills">
      {mode === 'button' ? (
        <input
          ref={searchRef} className="sl-search" placeholder="Search commands and skills" aria-label="Search commands and skills" value={query}
          autoComplete="off" spellCheck={false}
          onChange={(e) => { setQuery(e.currentTarget.value.replace(/^\//, '')); setActive(0); }}
          onKeyDown={(e) => onKey(e, false)}
        />
      ) : (
        <div className="sl-head"><span>Commands and skills</span><span><kbd>↑↓</kbd> move · <kbd>⇥</kbd> insert · <kbd>esc</kbd> close</span></div>
      )}
      <div className="sl-list" role="listbox" ref={listRef}>
        {rows.map(({ item, group }, i) => (
          <Fragment key={item.name}>
            {group && <div className="sl-gh">{group}</div>}
            <button
              type="button" tabIndex={-1} role="option" aria-selected={i === at} className="sl-row"
              onMouseMove={() => i !== at && setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(item)}
            >
              <span className="sl-nm">/{item.name}{item.hint && <i>{item.hint}</i>}</span>
              {item.skill && <span className="sl-tag">skill</span>}
              {item.description && <small>{item.description}</small>}
            </button>
          </Fragment>
        ))}
        {!rows.length && <div className="sl-empty">{commands.length ? 'No command matches' : 'Commands show up once a session starts'}</div>}
      </div>
    </div>,
    document.body,
  );

  // Picks a command by name from outside the menu; one the session has not listed yet still goes in.
  const put = (name: string) => insert(commands.find((c) => c.name === name) ?? { name, description: '', hint: '' });

  return { onInput, onKeyDown, button, argHint, panel, put };
}
