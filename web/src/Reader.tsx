import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from './store.ts';
import { Markdown, typedMarkdown } from './Markdown.tsx';
import { pref } from './bits.tsx';
import { HL, useReadEngine } from './readEngine.ts';
import { useOpen } from './stretch/store.ts';

// What the reader shows: a finished (or still streaming) agent message, or a pasted block.
// md renders the pasted text as Markdown (a handoff doc); label names it in the top bar.
// at/play hand over an inline reading: the word to resume from and whether it was playing.
export type ReadSource =
  | { itemId: string; paste?: undefined; edit?: undefined; at?: number; play?: boolean }
  // edit makes the paste editable; Focus calls it once with the final text when the view closes.
  | { paste: string; itemId?: undefined; md?: boolean; label?: string; edit?: (text: string) => void };

// The eye rests on one letter a little left of center (the optimal recognition point).
const orp = (t: string) => (t.length < 2 ? 0 : t.length < 6 ? 1 : t.length < 10 ? 2 : 3);

const Prose = memo(function Prose({ text, live, msg }: { text: string; live: boolean; msg?: string }) {
  return <Markdown text={text} live={live} reader msg={msg} />;
});

// A paste the owner wrote: Markdown, with each newline kept as a line break.
const Pasted = memo(function Pasted({ text }: { text: string }) {
  return <Markdown text={typedMarkdown(text)} reader typed />;
});

const span = (cls: string, t: string) => {
  const s = document.createElement(cls === 'b' ? 'b' : 'span');
  if (cls !== 'b') s.className = cls;
  s.textContent = t;
  return s;
};

export function Reader({ source, label, close }: { source: ReadSource; label: string; close: ReactNode }) {
  const itemText = useStore((s) => {
    const it = source.itemId ? s.items[source.itemId] : undefined;
    return it?.kind === 'agent' ? it.text : '';
  });
  const live = useStore((s) => !!source.itemId && s.status === 'working' && s.order[s.order.length - 1] === source.itemId);
  const body = source.paste ?? itemText;
  const stage = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLElement>(null);
  const bar = useRef<HTMLElement>(null);
  const rw = useRef<HTMLDivElement>(null);
  const rs = useRef<HTMLDivElement>(null);
  const [oneWord, setOneWord] = useState(() => !HL || pref.get('reader.oneWord', false));
  const one = useRef(oneWord);
  const [fits, setFits] = useState(false);
  const editing = source.edit !== undefined;
  const canRead = !live && !editing && body.trim().length > 0;
  const hand = useRef(source.itemId !== undefined && source.at !== undefined ? { at: source.at, play: !!source.play } : null);

  const r = useReadEngine({
    canRead,
    // Follow mode keeps the current line in the middle band of the stage.
    follow: () => (one.current || !stage.current ? null : { el: stage.current, top: 40, low: 0.62, to: 0.38 }),
    onShow: (wi, [a, b], words) => {
      const w = words[wi];
      if (bar.current) bar.current.style.transform = `scaleX(${(wi + 1) / words.length})`;
      const o = orp(w.t);
      rw.current?.replaceChildren(span('l', w.t.slice(0, o)), span('o', w.t[o] ?? ''), span('r', w.t.slice(o + 1)));
      rs.current?.replaceChildren(...words.slice(a, b + 1).flatMap((x, k) => [k ? ' ' : '', a + k === wi ? span('b', x.t) : x.t]));
    },
  });
  const { playing, wpm, started, atEnd, toggle, sentence, speed } = r;

  const style = (v: boolean) => {
    one.current = v;
    setOneWord(v);
    pref.set('reader.oneWord', v);
    if (!v && started) r.showWord(r.eng.current.wi);
  };

  // Rebuilt when the message finishes or a stretch opens, dropped while it streams.
  const open = useOpen(source.itemId);
  useLayoutEffect(() => r.reset(canRead ? art.current : null), [body, canRead, open]);

  useEffect(() => () => r.dispose(), []);

  // Short text sits in the middle of the screen; long text starts at the top and scrolls.
  useLayoutEffect(() => {
    const fit = () => art.current && stage.current && setFits(art.current.offsetHeight + 48 <= stage.current.clientHeight);
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, [body, open]);

  // An inline reading handed over: pick up at its word, then recentre once the opening animation settles.
  useLayoutEffect(() => {
    const h = hand.current;
    if (!h || !r.eng.current.words.length) return;
    hand.current = null;
    r.eng.current.wi = h.at;
    if (h.play) r.play();
    else r.showWord(h.at);
    const t = setTimeout(() => r.showWord(r.eng.current.wi), 340);
    return () => clearTimeout(t);
  }, [body, canRead]);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey || t.closest('input,textarea,[contenteditable]')) return;
    if (e.key === ' ' && !t.closest('button')) {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      sentence(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      speed(e.key === 'ArrowUp' ? 20 : -20);
    } else if (e.key === 'f' && HL) style(!one.current);
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  // Click a word to jump there; a drag that selects text is left alone.
  const onStageClick = (ev: React.MouseEvent) => {
    if (!canRead || (ev.target as Element).closest('button,a,.frame')) return;
    const k = r.wordAt(ev.clientX, ev.clientY);
    if (k >= 0) r.jump(k);
  };

  const rsvp = oneWord && (playing || started);
  const playLabel = playing ? 'Pause' : atEnd ? 'Read again' : started ? 'Resume' : 'Guided read';
  return (
    <div className={`fx-body${rsvp ? ' rsvp-on' : ''}`}>
      <div className="fx-top">
        <span className="fx-label">{label}</span>
        <span className="sp"></span>
        {!editing && <div className="rd-ctrl">
          {HL && (
            <div className="rd-seg" role="group" aria-label="Reading style">
              <button aria-pressed={!oneWord} onClick={() => style(false)} title="Highlight the sentence in place">Follow</button>
              <button aria-pressed={oneWord} onClick={() => style(true)} title="One word at a time, in the middle">One word</button>
            </div>
          )}
          <div className="rd-wpm">
            <button aria-label="Slower" title="Slower" onClick={() => speed(-20)}>−</button>
            <span>{wpm} wpm</span>
            <button aria-label="Faster" title="Faster" onClick={() => speed(20)}>+</button>
          </div>
          <button className="rd-play" onClick={toggle} disabled={!canRead} title={live ? 'Available once the reply finishes' : undefined}>
            {playing ? (
              <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><path d="M1.5 1v10M8.5 1v10" stroke="var(--on-fill,#fff)" strokeWidth="2" strokeLinecap="round" /></svg>
            ) : (
              <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><path d="M1 1.2v9.6L9 6z" fill="var(--on-fill,#fff)" /></svg>
            )}
            {playLabel}
          </button>
        </div>}
        {close}
      </div>
      <div className="rd-prog" aria-hidden="true"><b ref={bar}></b></div>
      <div className={`fx-stage${fits ? ' fits' : ''}${editing ? ' edit' : ''}`} ref={stage} tabIndex={-1} onClick={onStageClick}>
        {editing ? (
          <textarea className="rd-edit" defaultValue={body} spellCheck={false} aria-label="Pasted text" />
        ) : (
          <article className={`reader${started ? ' reading' : ''}`} ref={art}>
            {source.paste === undefined ? <Prose text={body} live={live} msg={source.itemId} /> : source.md ? <Prose text={source.paste} live={false} /> : <Pasted text={source.paste} />}
          </article>
        )}
      </div>
      <div className="rsvp" aria-live="off"><div className="rguide"></div><div className="rw" ref={rw}></div><div className="rguide"></div><div className="rs" ref={rs}></div></div>
      <div className="fx-foot">
        {editing ? (
          <><kbd>esc</kbd>close · edits are kept when it closes<kbd>ctrl ↵</kbd>close now</>
        ) : live ? (
          <><kbd>esc</kbd>close · guided reading starts once the reply finishes</>
        ) : (
          <><kbd>space</kbd>play / pause<kbd>← →</kbd>sentence<kbd>↑ ↓</kbd>speed{HL && <><kbd>f</kbd>style</>}<kbd>esc</kbd>close · click a word to jump there</>
        )}
      </div>
    </div>
  );
}
