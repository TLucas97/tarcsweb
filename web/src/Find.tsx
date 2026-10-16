import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useStore } from './store.ts';
import { reduceMotion, useEscape } from './bits.tsx';

const MAX = 2000;
const FIND_EVENT = 'cw:find';
const supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
// Inline elements keep a match alive across them ("a **b** c"); anything else ends the run of text.
const INLINE = new Set(['A', 'B', 'STRONG', 'EM', 'I', 'CODE', 'DEL', 'S', 'SUB', 'SUP', 'MARK', 'U', 'SMALL']);
// Controls and key hints are chrome, not conversation (diff rows are buttons but hold real text).
const CHROME = 'button:not(.trow),textarea,script,style,kbd,.qtag';

// Case-insensitive ranges over the rendered text, in document order. Folded <details> are still in the DOM, so they are found too.
function scan(col: HTMLElement, needle: string): Range[] {
  const out: Range[] = [];
  const walker = document.createTreeWalker(col, NodeFilter.SHOW_TEXT);
  const skip = new Map<Element, boolean>();
  let box: Element | null = null;
  let segs: { node: Text; at: number }[] = [];
  let buf = '';

  const flush = () => {
    let k = 0;
    for (let i = buf.indexOf(needle); i !== -1 && out.length < MAX; i = buf.indexOf(needle, i + needle.length)) {
      const end = i + needle.length;
      while (k + 1 < segs.length && segs[k + 1].at <= i) k++;
      let j = k;
      while (j + 1 < segs.length && segs[j + 1].at < end) j++;
      const r = new Range();
      r.setStart(segs[k].node, i - segs[k].at);
      r.setEnd(segs[j].node, end - segs[j].at);
      out.push(r);
    }
    buf = '';
    segs = [];
  };

  for (let n = walker.nextNode() as Text | null; n && out.length < MAX; n = walker.nextNode() as Text | null) {
    const parent = n.parentElement;
    if (!parent || !n.data) continue;
    let hide = skip.get(parent);
    if (hide === undefined) skip.set(parent, (hide = !!parent.closest(CHROME)));
    if (hide) continue;
    let top: Element | null = parent;
    while (top && top !== col && INLINE.has(top.tagName)) top = top.parentElement;
    if (top !== box) {
      flush();
      box = top;
    }
    // A lowercase form that changes length would shift every later offset, so keep the original there.
    const low = n.data.toLowerCase();
    segs.push({ node: n, at: buf.length });
    buf += low.length === n.data.length ? low : n.data;
  }
  flush();
  return out;
}

function paint(all: Range[], cur: Range | undefined) {
  if (!supported) return;
  CSS.highlights.set('fnd', new Highlight(...all));
  if (!cur) return void CSS.highlights.delete('fnd-cur');
  const h = new Highlight(cur);
  h.priority = 1;
  CSS.highlights.set('fnd-cur', h);
}

function unpaint() {
  if (!supported) return;
  CSS.highlights.delete('fnd');
  CSS.highlights.delete('fnd-cur');
}

// Opens the folded lists around a range; true when something opened.
function unfold(r: Range) {
  let opened = false;
  let el = r.startContainer.parentElement;
  for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details')) {
    // The summary line stays visible when the list is closed.
    if (!d.open && el?.closest('summary')?.parentElement !== d) {
      d.open = true;
      opened = true;
    }
    el = d.parentElement;
  }
  return opened;
}

const Svg = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

// The small magnifier beside the title; the bar itself lives in FindBar.
export function FindTrigger() {
  return (
    <button className="fnd-open" onClick={() => window.dispatchEvent(new Event(FIND_EVENT))} title="Find in conversation (Ctrl F)" aria-label="Find in conversation">
      <Svg d="M6 10.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM9.4 9.4 12.5 12.5" />
    </button>
  );
}

// Find in the conversation: Ctrl/Cmd+F or the trigger beside the title opens it, in the title's place; matches are painted with the CSS Custom Highlight API, so the DOM stays untouched.
export function FindBar({ convRef, release }: { convRef: RefObject<HTMLElement | null>; release: () => void }) {
  const hasSession = useStore((s) => !!s.current);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState({ i: 0, n: 0 });
  const input = useRef<HTMLInputElement>(null);
  const hits = useRef<Range[]>([]);
  const at = useRef(0);
  const job = useRef(0);

  const reveal = (id: number, opened: boolean) => {
    const conv = convRef.current;
    const r = hits.current[at.current];
    if (id !== job.current || !conv || !r?.startContainer.isConnected) return;
    const rect = r.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const box = conv.getBoundingClientRect();
    // The top 72px of the view fades out, so a match there counts as hidden.
    if (rect.top >= box.top + 90 && rect.bottom <= box.bottom - 40) {
      // A list that just opened may have changed the layout; let the view re-check its position.
      if (opened) conv.dispatchEvent(new Event('scroll'));
      return;
    }
    release();
    conv.scrollTo({ top: conv.scrollTop + rect.top - (box.top + box.height * 0.35), behavior: reduceMotion() ? 'auto' : 'smooth' });
  };

  const go = (i: number) => {
    const r = hits.current[i];
    if (!r) return;
    at.current = i;
    setPos({ i, n: hits.current.length });
    paint(hits.current, r);
    const opened = unfold(r);
    // Release before the list grows, or the follow-the-bottom logic snaps the view away.
    if (opened) release();
    const id = ++job.current;
    // A list animates open, so its match has no position until the animation ends.
    if (opened) setTimeout(() => reveal(id, true), 260);
    else requestAnimationFrame(() => reveal(id, false));
  };

  // keep: a refresh while the conversation changes; the current match stays and the view does not move.
  const search = (text: string, keep: boolean) => {
    const col = convRef.current?.querySelector<HTMLElement>('.col');
    const found = col && text ? scan(col, text.toLowerCase()) : [];
    hits.current = found;
    if (!found.length) {
      at.current = 0;
      setPos({ i: 0, n: 0 });
      return unpaint();
    }
    if (keep) {
      const i = Math.min(at.current, found.length - 1);
      at.current = i;
      setPos({ i, n: found.length });
      return paint(found, found[i]);
    }
    // Start at the first match from the top of the view, or the last one when none is below.
    const top = convRef.current!.getBoundingClientRect().top + 90;
    const below = found.findIndex((r) => r.getBoundingClientRect().top >= top);
    paint(found, undefined);
    go(below === -1 ? found.length - 1 : below);
  };

  const step = (by: number) => {
    const n = hits.current.length;
    if (n) go((at.current + by + n) % n);
  };

  const close = () => {
    job.current++;
    unpaint();
    hits.current = [];
    setOpen(false);
  };

  const show = () => {
    const sel = getSelection();
    const text = sel?.toString().trim() ?? '';
    const inConv = !!sel?.anchorNode && !!convRef.current?.contains(sel.anchorNode);
    if (inConv && text && text.length <= 120 && !text.includes('\n')) setQ(text);
    setOpen(true);
    input.current?.focus();
    input.current?.select();
  };

  useEscape(open, close);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      const s = useStore.getState();
      if (!s.current || s.palette || s.replayView || s.viewer || document.querySelector(':popover-open, dialog[open]')) return;
      e.preventDefault();
      show();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    window.addEventListener(FIND_EVENT, show);
    return () => window.removeEventListener(FIND_EVENT, show);
  }, []);

  // Typing is debounced; an empty box clears at once.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(q, false), q ? 120 : 0);
    return () => clearTimeout(t);
  }, [open, q]);

  // Streaming and new messages change the text; rescan at most twice a second and ignore the working timer.
  useEffect(() => {
    const col = convRef.current?.querySelector<HTMLElement>('.col');
    if (!open || !q || !col) return;
    let timer = 0;
    const mo = new MutationObserver((records) => {
      const real = records.some((r) => !(r.target instanceof Element ? r.target : r.target.parentElement)?.closest('.working'));
      if (!real || timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        search(q, true);
      }, 400);
    });
    mo.observe(col, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      clearTimeout(timer);
    };
  }, [open, q]);

  useEffect(() => () => unpaint(), []);

  // The session changed or ended: nothing to search.
  useEffect(() => {
    if (!hasSession && open) close();
  }, [hasSession]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  };

  if (!hasSession || !open) return null;
  const label = !q ? '' : pos.n === 0 ? 'No results' : `${pos.i + 1} / ${pos.n}${pos.n >= MAX ? '+' : ''}`;
  return (
    <div className="fnd" role="search">
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Find in conversation" aria-label="Find in conversation" spellCheck={false} autoFocus />
      <span className={`fnd-n${q && !pos.n ? ' none' : ''}`} aria-live="polite">{label}</span>
      <button onClick={() => step(-1)} disabled={!pos.n} title="Previous (Shift Enter)" aria-label="Previous match"><Svg d="M3 8.5 7 4.5l4 4" /></button>
      <button onClick={() => step(1)} disabled={!pos.n} title="Next (Enter)" aria-label="Next match"><Svg d="M3 5.5l4 4 4-4" /></button>
      <button onClick={close} title="Close (Esc)" aria-label="Close find"><Svg d="M4 4l6 6M10 4l-6 6" /></button>
    </div>
  );
}
