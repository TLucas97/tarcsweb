import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { TextLink } from '../../server/protocol.ts';

// A composer span tied to a tray item: offsets into the textarea value and the item's key.
export type DraftLink = { start: number; end: number; key: string };
// A tray item a span can link to; num is its number in the tray.
export type TrayItem = { key: string; num: number; name: string; thumb: string | null };

const TINTS = 6;
export const tintOf = (num: number) => String((num - 1) % TINTS);

export function NumBadge({ num }: { num: number }) {
  return <b className="lk-num" data-lk={tintOf(num)} aria-hidden="true">{num}</b>;
}

// Moves links through one edit found by a prefix/suffix diff. The caret ends the inserted text, which settles
// ambiguous repeats; text inserted strictly inside a span grows it, at its edges it stays outside.
export function shiftLinks(links: DraftLink[], before: string, after: string, caret: number): DraftLink[] {
  if (!links.length || before === after) return links;
  const min = Math.min(before.length, after.length);
  const sMax = Math.min(min, Math.max(0, after.length - caret));
  let s = 0;
  while (s < sMax && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  let p = 0;
  while (p < min - s && before[p] === after[p]) p++;
  const oldEnd = before.length - s;
  const newEnd = after.length - s;
  const delta = after.length - before.length;
  let changed = false;
  const out: DraftLink[] = [];
  for (const l of links) {
    let { start, end } = l;
    if (end <= p) {
      // The edit is after the span.
    } else if (start >= oldEnd) {
      start += delta;
      end += delta;
    } else {
      start = start < p ? start : newEnd;
      end = end > oldEnd ? end + delta : p;
    }
    if (start === l.start && end === l.end) out.push(l);
    else {
      changed = true;
      if (start < end) out.push({ ...l, start, end });
    }
  }
  return changed ? out : links;
}

// The selection without its outer whitespace; null when nothing but whitespace is selected.
export function trimRange(text: string, from: number, to: number): [number, number] | null {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return from < to ? [from, to] : null;
}

// Adds a link, replacing any it overlaps, kept in text order.
export function withLink(links: DraftLink[], from: number, to: number, key: string): DraftLink[] {
  return [...links.filter((l) => l.end <= from || l.start >= to), { start: from, end: to, key }].sort((a, b) => a.start - b.start);
}

type Mark = { start: number; end: number; tint: string };

// The mirror repeats the textarea's text behind it so linked spans can be tinted without touching the native field.
export function paintMirror(mirror: HTMLElement, text: string, marks: Mark[]) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const m of marks) {
    if (m.start < at || m.end > text.length) continue;
    if (m.start > at) frag.append(text.slice(at, m.start));
    const el = document.createElement('mark');
    el.dataset.lk = m.tint;
    el.dataset.at = String(m.start);
    el.textContent = text.slice(m.start, m.end);
    frag.append(el);
    at = m.end;
  }
  // A trailing newline needs a character after it to take up its line, as in the textarea.
  frag.append(text.slice(at) + '​');
  mirror.replaceChildren(frag);
  mirror.dataset.text = String(text.length);
}

// Copies the textarea's box and type onto the mirror; called from observers and when the mirror turns on.
export function placeMirror(mirror: HTMLElement, t: HTMLTextAreaElement) {
  const cs = getComputedStyle(t);
  const s = mirror.style;
  s.left = `${t.offsetLeft + t.clientLeft}px`;
  s.top = `${t.offsetTop + t.clientTop}px`;
  s.width = `${t.clientWidth}px`;
  s.height = `${t.clientHeight}px`;
  s.padding = cs.padding;
  s.fontFamily = cs.fontFamily;
  s.fontSize = cs.fontSize;
  s.fontWeight = cs.fontWeight;
  s.fontStyle = cs.fontStyle;
  s.lineHeight = cs.lineHeight;
  s.letterSpacing = cs.letterSpacing;
  s.wordSpacing = cs.wordSpacing;
  s.tabSize = cs.tabSize;
  mirror.scrollTop = t.scrollTop;
}

// Viewport box of the character at offset, read from the mirror (painted for the current text, so it ends in ​).
function charRect(mirror: HTMLElement, at: number): DOMRect | null {
  const walk = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
  let left = at;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = n.textContent!.length;
    if (left < len) {
      const r = document.createRange();
      r.setStart(n, left);
      r.setEnd(n, Math.min(len, left + (n.textContent![left] === '\n' ? 0 : 1)));
      return r.getClientRects()[0] ?? r.getBoundingClientRect();
    }
    left -= len;
  }
  return null;
}

type Bar = { from: number; to: number; left: number; top: number };
type Pop = { link: DraftLink; left: number; top: number };

const BAR_H = 30;
const GAP = 8;
const NAME_MAX = 16;
const short = (s: string) => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s);

// Start offset of the tinted span under a viewport point, from the mirror's marks.
function markAt(mirror: HTMLElement, x: number, y: number): number | null {
  for (const el of mirror.querySelectorAll<HTMLElement>('mark')) {
    for (const r of el.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(el.dataset.at);
  }
  return null;
}

// The floating bar over text selected in the composer and the popover for a linked span the user clicked.
export function LinkTools({ promptRef, mirrorRef, links, tray, paint, onLink, onMove, onUnlink }: {
  promptRef: RefObject<HTMLTextAreaElement | null>;
  mirrorRef: RefObject<HTMLDivElement | null>;
  links: DraftLink[];
  tray: TrayItem[];
  paint: () => void;
  onLink: (from: number, to: number, key: string) => void;
  onMove: (from: number, to: number) => void;
  onUnlink: (link: DraftLink) => void;
}) {
  const [bar, setBar] = useState<Bar | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Latest values for the textarea listeners, which are added once.
  const live = useRef({ links, paint, open: false });
  useEffect(() => {
    live.current = { links, paint, open: !!(bar || pop) };
  });

  useEffect(() => {
    const t = promptRef.current!;
    let timer = 0;
    let frame = 0;
    let down: { x: number; y: number } | null = null;
    const close = () => {
      clearTimeout(timer);
      setBar(null);
      setPop(null);
    };
    const spot = (at: number) => {
      const m = mirrorRef.current;
      if (!m) return null;
      live.current.paint();
      const r = charRect(m, at);
      if (!r) return null;
      const box = t.getBoundingClientRect();
      return { left: r.left, top: Math.max(r.top, box.top) - BAR_H - GAP };
    };
    // The linked span under the pointer; the mirror is repainted first if typing left it behind the text.
    const linkAt = (x: number, y: number) => {
      const m = mirrorRef.current;
      if (!m || !live.current.links.length) return null;
      if (m.dataset.text !== String(t.value.length)) live.current.paint();
      const at = markAt(m, x, y);
      return at === null ? null : (live.current.links.find((l) => l.start === at) ?? null);
    };
    // clicked: the span under a click; only a click opens its popover, so moving the caret through text never does.
    const check = (clicked: DraftLink | null) => {
      if (document.activeElement !== t) return close();
      const { selectionStart: a, selectionEnd: b } = t;
      if (a !== b) {
        const r = trimRange(t.value, a, b);
        const at = r && spot(r[0]);
        setPop(null);
        return setBar(r && at ? { from: r[0], to: r[1], ...at } : null);
      }
      setBar(null);
      const at = clicked && spot(clicked.start);
      setPop(clicked && at ? { link: clicked, ...at } : null);
    };
    const later = (fn: () => void, ms: number) => {
      clearTimeout(timer);
      timer = window.setTimeout(fn, ms);
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      close();
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      // A drag selects text; only a click that stays put counts as clicking the span.
      const still = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4;
      down = null;
      const clicked = still ? linkAt(e.clientX, e.clientY) : null;
      later(() => check(clicked), 0);
    };
    const onSelect = () => {
      if (!down && document.activeElement === t) later(() => check(null), 150);
    };
    // The pointer cursor marks linked spans as clickable; one hit test per frame at most.
    const onMove = (e: PointerEvent) => {
      if (frame || e.buttons) return;
      const { clientX: x, clientY: y } = e;
      frame = requestAnimationFrame(() => {
        frame = 0;
        t.style.cursor = linkAt(x, y) ? 'var(--hand,pointer)' : '';
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      t.style.cursor = '';
    };
    // Esc closes the bar and must not reach the global handler, which would stop the turn.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !live.current.open) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onBlur = () =>
      later(() => {
        if (!boxRef.current?.contains(document.activeElement)) close();
      }, 0);
    t.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('selectionchange', onSelect);
    t.addEventListener('pointermove', onMove);
    t.addEventListener('pointerleave', onLeave);
    t.addEventListener('keydown', onKey);
    t.addEventListener('input', close);
    t.addEventListener('scroll', close);
    t.addEventListener('blur', onBlur);
    addEventListener('resize', close);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      t.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('selectionchange', onSelect);
      t.removeEventListener('pointermove', onMove);
      t.removeEventListener('pointerleave', onLeave);
      t.removeEventListener('keydown', onKey);
      t.removeEventListener('input', close);
      t.removeEventListener('scroll', close);
      t.removeEventListener('blur', onBlur);
      removeEventListener('resize', close);
    };
  }, [promptRef, mirrorRef]);

  // A link that went away (removed, or its attachment removed) closes its popover.
  const shown = pop && links.some((l) => l.key === pop.link.key && l.start === pop.link.start) ? pop : null;

  // Keeps the box inside the window once its width is known.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    el.style.left = `${Math.max(GAP, Math.min(Number.parseFloat(el.style.left), innerWidth - w - GAP))}px`;
  }, [bar, shown]);

  const done = (caret?: number) => {
    setBar(null);
    setPop(null);
    const t = promptRef.current!;
    t.focus({ preventScroll: true });
    if (caret !== undefined) t.setSelectionRange(caret, caret);
  };
  const keep = (e: React.PointerEvent) => e.preventDefault();
  const esc = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    done();
  };

  if (bar) {
    return createPortal(
      <div className="xbtn stc-pair lk-bar" role="toolbar" aria-label="Selected text" style={{ left: bar.left, top: bar.top }} ref={boxRef} onPointerDown={keep} onKeyDown={esc}>
        {tray.length > 0 && (
          <>
            <span className="lk-lbl" id="lk-lbl">Link to</span>
            <span className="lk-picks" role="group" aria-labelledby="lk-lbl">
              {tray.map((it) => (
                <button
                  type="button" key={it.key} className="stc-act lk-pick" title={`Link the selection to attachment ${it.num}: ${it.name}`}
                  aria-label={`Link to attachment ${it.num}, ${it.name}`}
                  onClick={() => {
                    onLink(bar.from, bar.to, it.key);
                    done(bar.to);
                  }}
                >
                  <NumBadge num={it.num} />
                  {it.thumb ? <img src={it.thumb} alt="" /> : <span>{short(it.name)}</span>}
                </button>
              ))}
            </span>
            <i className="stc-sep" aria-hidden="true" />
          </>
        )}
        <button
          type="button" className="stc-act" title="Take the selected text out of the message and attach it instead"
          onClick={() => {
            onMove(bar.from, bar.to);
            done();
          }}
        >
          Move to attachment
        </button>
      </div>,
      document.body,
    );
  }
  if (shown) {
    const it = tray.find((x) => x.key === shown.link.key);
    if (!it) return null;
    return createPortal(
      <div className="xbtn stc-pair lk-pop" role="dialog" aria-label="Linked text" style={{ left: shown.left, top: shown.top }} ref={boxRef} onPointerDown={keep} onKeyDown={esc}>
        <span className="lk-lbl">Linked to <NumBadge num={it.num} /> {short(it.name)}</span>
        <i className="stc-sep" aria-hidden="true" />
        <button
          type="button" className="stc-act"
          onClick={() => {
            onUnlink(shown.link);
            done();
          }}
        >
          Remove link
        </button>
      </div>,
      document.body,
    );
  }
  return null;
}

// A sent prompt with links: plain text as typed, each linked span tinted and tagged with its attachment number.
export function LinkedSpans({ text, links }: { text: string; links: TextLink[] }) {
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const l of [...links].sort((a, b) => a.start - b.start)) {
    if (l.start < at || l.end > text.length) continue;
    if (l.start > at) out.push(text.slice(at, l.start));
    const num = l.at + 1;
    out.push(
      <mark key={l.start} className="lk-mark" data-lk={tintOf(num)} title={`Refers to attachment ${num}`}>
        {text.slice(l.start, l.end)}<sup className="lk-sup">{num}</sup>
      </mark>,
    );
    at = l.end;
  }
  out.push(text.slice(at));
  return <p className="lk-text">{out}</p>;
}
