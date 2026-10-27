import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLayoutVars } from './layoutVars.ts';
import { MenuList, type MenuApi } from './MenuList.tsx';
import { useStore } from './store.ts';
import type { SlashItem } from '../../server/protocol.ts';
import { APP_COMMANDS, APP_NAMES, needsArg, runApp, type AppItem } from './appCommands.ts';
import { loadSkillPaths, skillRef } from './skills/paths.ts';
import type { SkillRef } from './skills/ref.tsx';

type Mode = 'typed' | 'button' | null;
type Item = SlashItem | AppItem;
type Row = { item: Item; group?: string };

const isApp = (c: Item): c is AppItem => 'app' in c;
// Built-ins lead as before, so Enter on a bare "/" still types one instead of running an app command.
const kindOf = (c: Item) => (isApp(c) ? 1 : c.skill ? 2 : 0);
const GROUPS = ['Built-in', 'App', 'Skills'];

// Name and aliases rank first, then description; an empty query lists built-ins, app commands, then skills.
function rank(list: Item[], query: string): Row[] {
  const q = query.toLowerCase();
  const byName = (a: Item, b: Item) => a.name.localeCompare(b.name);
  if (!q) {
    const sorted = [...list].sort((a, b) => kindOf(a) - kindOf(b) || byName(a, b));
    return sorted.map((item, i) => ({ item, ...(i === 0 || kindOf(sorted[i - 1]) !== kindOf(item) ? { group: GROUPS[kindOf(item)] } : {}) }));
  }
  const score = (c: Item) => {
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
    .sort((a, b) => a.s - b.s || kindOf(a.item) - kindOf(b.item) || byName(a.item, b.item))
    .map(({ item }) => ({ item }));
}

// The "/token" around the caret, at the start of the prompt (lead) or after whitespace; a second slash makes it a path.
function token(t: HTMLTextAreaElement) {
  const v = t.value;
  const c = t.selectionStart;
  if (c !== t.selectionEnd || c === 0) return null;
  const m = /(^|\s)\/([^\s/]*)$/.exec(v.slice(0, c));
  if (!m) return null;
  const start = m.index + m[1].length;
  const ws = v.slice(c).search(/\s/);
  const end = ws < 0 ? v.length : c + ws;
  const query = v.slice(start + 1, end);
  return query.includes('/') ? null : { start, end, query, lead: !v.slice(0, start).trim() };
}

// The leading "/token" of the prompt, replaced when a command goes in as text.
const leadEnd = (v: string) => /^\/\S*/.exec(v)?.[0].length ?? 0;

const SlashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3" /><path d="M9.6 5 6.4 11" />
  </svg>
);

// The composer's /command menu: opened by typing "/" at the start or after a space, or by its button with a search field.
// Mid-text it lists skills only, since commands run only at the start; a picked skill becomes a chip through onSkill.
export function useSlash(promptRef: RefObject<HTMLTextAreaElement | null>, onSkill: (r: SkillRef) => void) {
  const current = useStore((s) => s.current);
  const commands = useStore((s) => {
    const own = s.current ? s.commands?.[s.current] : undefined;
    return own?.length ? own : (s.lastCommands ?? []);
  });
  const [mode, setMode] = useState<Mode>(null);
  const [query, setQuery] = useState('');
  const [lead, setLead] = useState(true);
  // The command at the start of the prompt while its arguments are still empty.
  const [arg, setArg] = useState<Item | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popEl = useLayoutVars(popRef);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listApi = useRef<MenuApi>(null);
  const placed = useRef<Mode>(null);

  const sdk = commands.filter((c) => !APP_NAMES.has(c.name));
  const all: Item[] = [...APP_COMMANDS, ...sdk];
  const list = mode === 'button' || lead ? all : sdk.filter((c) => c.skill);
  const rows = mode ? rank(list, query) : [];
  const shown = mode === 'button' || (mode === 'typed' && rows.length > 0);

  const close = () => setMode(null);

  const refreshArg = () => {
    const t = promptRef.current;
    const m = t ? /^\/(\S+)\s+$/.exec(t.value) : null;
    const item = m ? all.find((c) => c.name === m[1]) : undefined;
    setArg(item?.hint ? item : null);
  };

  // Called on every prompt input: opens, filters or closes the typed menu.
  const onInput = () => {
    const t = promptRef.current;
    refreshArg();
    if (!t || mode === 'button') return;
    const k = token(t);
    if (!k) return close();
    if (mode !== 'typed') loadSkillPaths(current);
    setQuery(k.query);
    setLead(k.lead);
    setMode('typed');
  };

  // The command goes in as text at the start of the prompt, where the SDK runs it.
  const insertText = (item: Item) => {
    const t = promptRef.current;
    if (!t) return;
    const end = leadEnd(t.value);
    const spaces = /^[ \t]*/.exec(t.value.slice(end))![0].length;
    t.focus();
    t.setRangeText(`/${item.name} `, 0, end + spaces, 'end');
    setMode(null);
    // The composer's own input handler resizes the box and saves the draft.
    t.dispatchEvent(new Event('input', { bubbles: true }));
    setArg(item.hint ? item : null);
  };

  // Takes the typed token out (with the spaces after it), undoable like typing.
  const cut = (t: HTMLTextAreaElement, start: number, end: number) => {
    const to = end + /^[ \t]*/.exec(t.value.slice(end))![0].length;
    t.focus();
    t.setSelectionRange(start, to);
    if (document.execCommand('delete')) return;
    t.setRangeText('', start, to, 'end');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // A skill without a known SKILL.md (a plugin command, an MCP prompt) still runs as a command at the start.
  const addSkill = async (name: string, atStart: boolean) => {
    const sid = current;
    const ref = await skillRef(name, sid);
    if (useStore.getState().current !== sid) return;
    if (ref) return onSkill(ref);
    if (atStart) insertText(all.find((c) => c.name === name) ?? { name, description: '', hint: '' });
    else useStore.setState({ notice: `/${name} has no skill file to attach; type it at the start to run it`, noticeInfo: true });
  };

  // tab: Tab puts an app command in as text, so arguments can follow.
  const pick = (item: Item, tab = false) => {
    const t = promptRef.current;
    if (!t) return;
    const k = mode === 'typed' ? token(t) : null;
    setMode(null);
    if (isApp(item) && !tab && !needsArg(item)) {
      if (k) cut(t, k.start, k.end);
      return runApp(item, '');
    }
    if (!isApp(item) && item.skill) {
      if (k) cut(t, k.start, k.end);
      return void addSkill(item.name, k ? k.lead : !t.value.trim());
    }
    insertText(item);
  };

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
      listApi.current?.move(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    const row = rows[listApi.current?.at() ?? 0];
    if (!row || e.shiftKey || e.altKey) return false;
    if (e.key === 'Tab' || e.key === 'Enter') {
      // At the start a fully typed name sends as is (the SDK or the app runs it); Ctrl+Enter always sends.
      if (typed && e.key === 'Enter' && (e.ctrlKey || e.metaKey || (lead && query === row.item.name))) {
        close();
        return false;
      }
      e.preventDefault();
      e.stopPropagation();
      pick(row.item, e.key === 'Tab');
      return true;
    }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => (mode === 'typed' && shown ? onKey(e, true) : false);

  const toggle = () => {
    if (mode === 'button') return close();
    loadSkillPaths(current);
    setQuery('');
    setMode('button');
  };

  // Left-aligned to the composer when typed, right-aligned to the / button when opened from it; --ch keeps it above a growing composer.
  // Layout is read only when it opens or switches mode, not on every keystroke or hover.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    if (!shown) {
      placed.current = null;
      if (pop.matches(':popover-open')) pop.hidePopover();
      return;
    }
    if (placed.current === mode) return;
    placed.current = mode;
    const form = promptRef.current?.closest('form');
    if (form) {
      const r = form.getBoundingClientRect();
      const w = Math.min(560, r.width);
      const btn = mode === 'button' ? btnRef.current?.getBoundingClientRect() : null;
      pop.style.left = `${btn ? Math.max(12, Math.min(btn.right - w, innerWidth - w - 12)) : r.left}px`;
      pop.style.width = `${w}px`;
    }
    if (!pop.matches(':popover-open')) pop.showPopover();
    if (mode === 'button') searchRef.current?.focus({ preventScroll: true });
  });

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

  const renderRow = (i: number, selected: boolean) => {
    const { item, group } = rows[i];
    return (
      <>
        {group && <div className="sl-gh">{group}</div>}
        <button
          type="button" tabIndex={-1} role="option" aria-selected={selected} className="sl-row" data-i={i}
          onMouseDown={(e) => e.preventDefault()} onClick={() => pick(item)}
        >
          <span className="sl-nm">/{item.name}{item.hint && <i>{item.hint}</i>}</span>
          {isApp(item) ? <span className="sl-tag">app</span> : item.skill && <span className="sl-tag">skill</span>}
          {item.description && <small>{item.description}</small>}
        </button>
      </>
    );
  };

  const argHint = arg ?<span className="sl-arghint" aria-hidden="true">{arg.hint}</span> : null;

  const panel = createPortal(
    <div className="sl-pop" popover="manual" ref={popEl} aria-label="Commands and skills">
      {mode === 'button' ? (
        <input
          ref={searchRef} className="sl-search" placeholder="Search commands and skills" aria-label="Search commands and skills" value={query}
          autoComplete="off" spellCheck={false}
          onChange={(e) => setQuery(e.currentTarget.value.replace(/^\//, ''))}
          onKeyDown={(e) => onKey(e, false)}
        />
      ) : (
        <div className="sl-head"><span>{lead ? 'Commands and skills' : 'A skill picked here is attached to the message'}</span><span><kbd>↑↓</kbd> move · <kbd>⇥</kbd> insert · <kbd>esc</kbd> close</span></div>
      )}
      <MenuList count={rows.length} reset={`${mode}:${lead}:${query}`} api={listApi} keyOf={(i) => `${kindOf(rows[i].item)}:${rows[i].item.name}`} render={renderRow}>
        {!rows.length && <div className="sl-empty">No command matches</div>}
      </MenuList>
    </div>,
    document.body,
  );

  // Picks a command by name from outside the menu; one the session has not listed yet still goes in.
  const put = (name: string) => insertText(all.find((c) => c.name === name) ?? { name, description: '', hint: '' });

  return { onInput, onKeyDown, button, argHint, panel, put };
}
