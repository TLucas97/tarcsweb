import { useEffect, useLayoutEffect, useRef } from 'react';
import { create } from 'zustand';
import { onSent, useStore } from './store.ts';
import { useEscape } from './bits.tsx';
import { openText, useFocus } from './Focus.tsx';
import { useReadEngine, type Word } from './readEngine.ts';

// The agent message being read inline; one reading at a time.
const useInline = create<{ id: string | null }>(() => ({ id: null }));

// The conversation lends its stick-to-bottom release, so following the reading is never pulled back down.
let release = () => {};
export function bindInlineRelease(fn: () => void) {
  release = fn;
  return () => {
    if (release === fn) release = () => {};
  };
}
export const releaseFollow = () => release();

// The conversation's top 72px fade out, so words there count as hidden.
const TOP = 80;

const PLAY = <svg width="9" height="10" viewBox="0 0 10 12" aria-hidden="true"><path d="M1 1.2v9.6L9 6z" fill="currentColor" /></svg>;
const PAUSE = <svg width="9" height="10" viewBox="0 0 10 12" aria-hidden="true"><path d="M1.5 1v10M8.5 1v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
const EXPAND = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.5 1.5h3v3M10.5 1.5 7 5M4.5 10.5h-3v-3M1.5 10.5 5 7" />
  </svg>
);
const X = <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>;

// The "Read" affordance on a finished agent message; it turns into the control bar in place.
export function InlineRead({ id, text, live }: { id: string; text: string; live: boolean }) {
  const on = useInline((s) => s.id === id);
  if (live || !text.trim()) return null;
  if (on) return <InlineBar id={id} text={text} />;
  return (
    <button type="button" className="ird ird-go" aria-label="Guided reading here" title="Guided reading here" onClick={() => useInline.setState({ id })}>
      {PLAY}Read
    </button>
  );
}

// First word below the top fade, so reading starts where the eye already is.
function firstVisible(words: Word[], conv: HTMLElement | null) {
  if (!conv) return 0;
  const top = conv.getBoundingClientRect().top + TOP;
  return Math.max(0, words.findIndex((w) => w.r.getBoundingClientRect().top >= top));
}

function InlineBar({ id, text }: { id: string; text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const playBtn = useRef<HTMLButtonElement>(null);
  const sayRef = useRef<HTMLElement | null>(null);
  const firstText = useRef(text);
  const current = useStore((s) => s.current);
  const firstSession = useRef(current);
  const view = useFocus((s) => s.view);
  const conv = () => box.current?.closest<HTMLElement>('.conv') ?? null;

  const r = useReadEngine({
    canRead: true,
    follow: () => {
      const el = conv();
      return el && { el, top: TOP, low: 0.62, to: 0.38, before: release };
    },
    onShow: () => release(),
  });

  const close = () => {
    const back = !!box.current?.contains(document.activeElement);
    const say = sayRef.current;
    useInline.setState({ id: null });
    if (back) requestAnimationFrame(() => say?.querySelector<HTMLElement>(':scope>.ird-go')?.focus({ preventScroll: true }));
  };

  // Hands the same word and play state to the fullscreen reader; closing it later does not come back here.
  const full = () => {
    const e = r.eng.current;
    const at = e.wi;
    const play = e.playing;
    const say = sayRef.current;
    r.dispose();
    useInline.setState({ id: null });
    if (say) openText({ itemId: id, at, play }, say);
  };

  useLayoutEffect(() => {
    const say = box.current?.closest<HTMLElement>('.say') ?? null;
    sayRef.current = say;
    say?.classList.add('ird-on');
    r.reset(say);
    r.eng.current.wi = r.sentOf(firstVisible(r.eng.current.words, conv()))[0];
    r.play();
    playBtn.current?.focus({ preventScroll: true });
    return () => {
      r.dispose();
      say?.classList.remove('ird-on');
      if (useInline.getState().id === id) useInline.setState({ id: null });
    };
  }, []);

  // New text, another session or the fullscreen reader opening all end the inline reading.
  useEffect(() => {
    if (text !== firstText.current || current !== firstSession.current || view) close();
  }, [text, current, view]);

  // Click a word in this message to jump there.
  useEffect(() => {
    const say = sayRef.current;
    if (!say) return;
    const onClick = (ev: MouseEvent) => {
      if ((ev.target as Element).closest('button,a,.frame,.ird')) return;
      const k = r.wordAt(ev.clientX, ev.clientY);
      if (k >= 0) r.jump(k);
    };
    say.addEventListener('click', onClick);
    return () => say.removeEventListener('click', onClick);
  }, []);

  // Sending a message takes the view to the bottom; a running read would drag it back up.
  useEffect(() => onSent(() => r.stop()), []);

  useEscape(true, close);
  // Space only while this reading is up, and never inside a field or on a focused control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[contenteditable],button,a,summary') || document.querySelector(':popover-open, dialog[open]')) return;
      e.preventDefault();
      if (!e.repeat) r.toggle();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const playTitle = r.playing ? 'Pause' : r.atEnd ? 'Read again' : 'Play';
  return (
    <div className="ird ird-bar" ref={box} role="toolbar" aria-label="Guided reading" aria-orientation="vertical">
      <button type="button" ref={playBtn} className="ird-play" onClick={r.toggle} aria-label={playTitle} title={`${playTitle} (Space)`}>
        {r.playing ? PAUSE : PLAY}
      </button>
      <button type="button" onClick={() => r.speed(20)} aria-label="Faster" title="Faster">+</button>
      <span className="ird-wpm" title={`${r.wpm} words per minute`}>
        {r.wpm}
        <small>wpm</small>
      </span>
      <button type="button" onClick={() => r.speed(-20)} aria-label="Slower" title="Slower">−</button>
      <span className="ird-sep" aria-hidden="true"></span>
      <button type="button" onClick={full} aria-label="Continue full screen" title="Continue full screen">{EXPAND}</button>
      <button type="button" onClick={close} aria-label="Stop reading" title="Stop reading (Esc)">{X}</button>
    </div>
  );
}
