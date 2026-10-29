import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { FindHit } from '../../server/protocol.ts';
import { onHistory, useStore } from './store.ts';
import { send } from './socket.ts';
import { reduceMotion, useEscape } from './bits.tsx';
import { overlayOpen } from './escape.ts';
import { afterFrames, reach, rowOf, showRow } from './convWindow.ts';
import { unfoldCode } from './Code.tsx';

// Painted matches in the mounted rows at most; the count comes from the server.
const MAX = 2000;
const RECOUNT_MS = 3000;
const FIND_EVENT = 'cw:find';
const supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
// Inline elements keep a match alive across them ("a **b** c"); anything else ends the run of text.
const INLINE = new Set(['A', 'B', 'STRONG', 'EM', 'I', 'CODE', 'DEL', 'S', 'SUB', 'SUP', 'MARK', 'U', 'SMALL']);
// Controls and key hints are chrome, not conversation (diff rows are buttons but hold real text).
const CHROME = 'button:not(.trow),textarea,script,style,kbd,.qtag';

// Case-insensitive ranges over the rendered text of one row, in document order, at most max.
// Folded <details> and code frames are still in the DOM, so they are found too.
function scan(row: Element, needle: string, max: number): Range[] {
  const out: Range[] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const skip = new Map<Element, boolean>();
  let box: Element | null = null;
  let segs: { node: Text; at: number }[] = [];
  let buf = '';

  const flush = () => {
    let k = 0;
    for (let i = buf.indexOf(needle); i !== -1 && out.length < max; i = buf.indexOf(needle, i + needle.length)) {
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

  for (let n = walker.nextNode() as Text | null; n && out.length < max; n = walker.nextNode() as Text | null) {
    const parent = n.parentElement;
    if (!parent || !n.data) continue;
    let hide = skip.get(parent);
    if (hide === undefined) skip.set(parent, (hide = !!parent.closest(CHROME)));
    if (hide) continue;
    let top: Element | null = parent;
    while (top && top !== row && INLINE.has(top.tagName)) top = top.parentElement;
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

// Opens the folded lists and code frames around a range; true when something opened.
function unfold(r: Range) {
  let opened = unfoldCode(r.startContainer);
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

// The header menu's Find entry; the bar itself lives in FindBar.
export const openFind = () => window.dispatchEvent(new Event(FIND_EVENT));
export const FindIcon = () => <Svg d="M6 10.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM9.4 9.4 12.5 12.5" />;

// The element of a hit's row, when mounted: its own node (a tool inside a list has one), else its row's.
function hitEl(col: Element, id: string) {
  return col.querySelector(`[data-id="${CSS.escape(id)}"]`) ?? col.querySelector(`[data-id="${CSS.escape(rowOf(id))}"]`);
}

// Find in the conversation (Ctrl/Cmd+F or the trigger by the title). The server searches the whole session; a match
// loads and mounts when reached, and mounted matches are painted with the CSS Custom Highlight API.
export function FindBar({ convRef, release }: { convRef: RefObject<HTMLElement | null>; release: () => void }) {
  const current = useStore((s) => s.current);
  const hasSession = !!current;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState({ i: 0, n: 0, more: false });
  const input = useRef<HTMLInputElement>(null);
  // Rows with matches, oldest first; starts[h] is the index of hit h's first match among all of them.
  const hits = useRef<FindHit[]>([]);
  const starts = useRef<number[]>([]);
  const total = useRef(0);
  const at = useRef(0);
  const cur = useRef<Range | undefined>(undefined);
  const job = useRef(0);
  const asked = useRef<{ q: string; keep: boolean } | null>(null);
  // The latest search: its text, and the conversation's seq and the time when it was sent.
  const last = useRef({ q: '', seq: 0, when: 0 });

  const locate = (g: number): [number, number] => {
    let h = 0;
    while (h + 1 < starts.current.length && starts.current[h + 1] <= g) h++;
    return [h, g - (starts.current[h] ?? 0)];
  };

  const reveal = (id: number, opened: boolean, tries = 3) => {
    const conv = convRef.current;
    const r = cur.current;
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
    // A far match jumps: rows rendered on arrival change height and move it, so look again once they have.
    const far = Math.abs(rect.top - box.top) > box.height * 2;
    conv.scrollTo({ top: conv.scrollTop + rect.top - (box.top + box.height * 0.35), behavior: far || reduceMotion() ? 'auto' : 'smooth' });
    if (far && tries > 0) afterFrames(() => reveal(id, false, tries - 1));
  };

  // Matches per mounted row for the query in rowQ; rows the observer saw change are scanned again, the rest reused.
  const rowHits = useRef(new Map<Element, Range[]>());
  const rowQ = useRef('');
  const dirty = useRef(new Set<Element>());

  // Paints every match in the mounted rows and picks the current one: the k-th inside the hit's own element.
  const repaint = (hit: FindHit | undefined, k: number) => {
    const col = convRef.current?.querySelector<HTMLElement>('.col');
    if (!col || !last.current.q) return;
    const needle = last.current.q.toLowerCase();
    const cache = rowHits.current;
    if (rowQ.current !== needle) {
      cache.clear();
      rowQ.current = needle;
    }
    const all: Range[] = [];
    for (const row of col.children) {
      const room = MAX - all.length;
      if (room <= 0) break;
      let rs = dirty.current.has(row) ? undefined : cache.get(row);
      if (!rs) {
        rs = scan(row, needle, room);
        // A row cut short by the cap is scanned whole next time.
        if (rs.length < room) cache.set(row, rs);
        else cache.delete(row);
      }
      for (let i = 0; i < rs.length && i < room; i++) all.push(rs[i]);
    }
    dirty.current.clear();
    for (const row of cache.keys()) if (row.parentNode !== col) cache.delete(row);
    const el = hit && hitEl(col, hit.id);
    const mine = el ? all.filter((r) => el.contains(r.startContainer)) : [];
    cur.current = mine[Math.min(k, mine.length - 1)];
    paint(all, cur.current);
  };

  // Loads the page holding match g when it is not loaded, mounts its row, then brings it into view.
  const go = async (g: number) => {
    const [h, k] = locate(g);
    const hit = hits.current[h];
    if (!hit) return;
    const id = ++job.current;
    at.current = g;
    setPos((p) => ({ ...p, i: g, n: total.current }));
    if (!(await reach(hit.id, hit.seq)) || id !== job.current) return;
    release();
    showRow(hit.id);
    afterFrames(() => {
      if (id !== job.current) return;
      repaint(hit, k);
      const r = cur.current;
      if (!r) return;
      const opened = unfold(r);
      // Release before the list grows, or the follow-the-bottom logic snaps the view away.
      if (opened) release();
      // A list animates open, so its match has no position until the animation ends.
      if (opened) setTimeout(() => reveal(id, true), 260);
      else reveal(id, false);
    });
  };

  // The first match at or below the top of the view; else the first past the mounted rows; else the newest.
  const startAt = () => {
    const col = convRef.current?.querySelector('.col');
    if (!col) return total.current - 1;
    const top = convRef.current!.getBoundingClientRect().top + 90;
    let lastMounted = -1;
    for (let h = 0; h < hits.current.length; h++) {
      const el = hitEl(col, hits.current[h].id);
      if (!el) continue;
      if (el.getBoundingClientRect().bottom >= top) return starts.current[h];
      lastMounted = h;
    }
    return lastMounted >= 0 && lastMounted + 1 < hits.current.length ? starts.current[lastMounted + 1] : total.current - 1;
  };

  // keep: a refresh while the conversation changes; the current match stays and the view does not move.
  const found = (list: FindHit[], more: boolean, keep: boolean) => {
    const was = hits.current[locate(at.current)[0]]?.id;
    const wasK = locate(at.current)[1];
    hits.current = list;
    let sum = 0;
    starts.current = list.map((h) => ((sum += h.n), sum - h.n));
    total.current = sum;
    if (!sum) {
      at.current = 0;
      setPos({ i: 0, n: 0, more: false });
      return unpaint();
    }
    if (keep) {
      const h = list.findIndex((x) => x.id === was);
      at.current = h >= 0 ? starts.current[h] + Math.min(wasK, list[h].n - 1) : Math.min(at.current, sum - 1);
      setPos({ i: at.current, n: sum, more });
      return repaint(list[locate(at.current)[0]], locate(at.current)[1]);
    }
    setPos({ i: 0, n: sum, more });
    void go(startAt());
  };

  const search = (text: string, keep: boolean) => {
    const s = useStore.getState();
    last.current = { q: text, seq: s.lastSeq, when: Date.now() };
    if (!text || !s.current) return found([], false, false);
    asked.current = { q: text, keep };
    send({ type: 'history-find', sessionId: s.current, query: text });
  };

  useEffect(() => onHistory((msg) => {
    const a = asked.current;
    if (msg.type !== 'history-found' || !a || msg.query !== a.q || msg.sessionId !== useStore.getState().current) return;
    asked.current = null;
    found(msg.error ? [] : msg.hits, msg.more, a.keep);
  }), []);

  const step = (by: number) => {
    const n = total.current;
    if (n) void go((at.current + by + n) % n);
  };

  const close = () => {
    job.current++;
    asked.current = null;
    unpaint();
    hits.current = [];
    total.current = 0;
    // Nothing watches the rows while closed, so their matches cannot be trusted on the next open.
    rowHits.current.clear();
    dirty.current.clear();
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
      if (!s.current || s.palette || s.replayView || s.viewer || overlayOpen()) return;
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

  // Typing is debounced, and each search goes to the server; an empty box clears at once. Another session searches anew.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(q, false), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [open, q, current]);

  // Rows mounting and streaming change the painted text; repaint at most twice a second, ignoring the working timer.
  // New events get a fresh count from the server, at most every few seconds.
  useEffect(() => {
    const col = convRef.current?.querySelector<HTMLElement>('.col');
    if (!open || !q || !col) return;
    let timer = 0;
    const mo = new MutationObserver((records) => {
      // The changed row: the target's ancestor directly under the column (found by class, so no element is held here).
      for (const r of records) {
        let n: Node | null = r.target;
        while (n && !(n.parentNode as Element | null)?.classList?.contains('col')) n = n.parentNode;
        if (n instanceof Element) dirty.current.add(n);
      }
      const real = records.some((r) => !(r.target instanceof Element ? r.target : r.target.parentElement)?.closest('.working'));
      if (!real || timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        const [h, k] = locate(at.current);
        repaint(hits.current[h], k);
        if (!asked.current && useStore.getState().lastSeq !== last.current.seq && Date.now() - last.current.when > RECOUNT_MS) search(q, true);
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
  const label = !q ? '' : pos.n === 0 ? 'No results' : `${pos.i + 1} / ${pos.n}${pos.more ? '+' : ''}`;
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
