import { useRef, useState } from 'react';
import { pref, reduceMotion } from './bits.tsx';
import { readTick } from './Sounds.ts';

// Guided reading marks words with the CSS Highlight API, so the text, its selection and React's nodes stay untouched.
export const HL = typeof Highlight === 'function' && !!CSS.highlights;
const hNow = HL ? new Highlight() : null;
const hSent = HL ? new Highlight() : null;
if (HL) {
  CSS.highlights.set('rd-now', hNow!);
  CSS.highlights.set('rd-sent', hSent!);
}
// Both readers share the marks; only the one that painted them last may clear them.
let owner: object | null = null;

export type Word = { r: Range; t: string; block: Element | null };
const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,.say';
export const END = /[.!?]["”')\]]?$/;

export function wordsOf(art: Element) {
  const words: Word[] = [];
  const tw = document.createTreeWalker(art, NodeFilter.SHOW_TEXT, {
    // Code and tables are skimmed, not read aloud word by word.
    acceptNode: (n) => (n.parentElement?.closest('.frame,.fx-btn,.macts,.ird,.st-x') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
    const block = n.parentElement?.closest(BLOCK) ?? null;
    for (const m of n.data.matchAll(/\S+/g)) {
      const r = new Range();
      r.setStart(n, m.index);
      r.setEnd(n, m.index + m[0].length);
      words.push({ r, t: m[0], block });
    }
  }
  const sents: [number, number][] = [];
  let st = 0;
  words.forEach((w, i) => {
    const nx = words[i + 1];
    if (END.test(w.t) || !nx || nx.block !== w.block) {
      sents.push([st, i]);
      st = i + 1;
    }
  });
  return { words, sents };
}

export function wordIndexAt(words: Word[], x: number, y: number) {
  const c = document.caretPositionFromPoint?.(x, y);
  if (!c) return -1;
  return words.findIndex((w) => w.r.startContainer === c.offsetNode && c.offset >= w.r.startOffset && c.offset <= w.r.endOffset);
}

// Keeps the current line between `top` px and `low` (a fraction of the height) of el, recentring it at `to`.
export type Follow = { el: HTMLElement; top: number; low: number; to: number; before?: () => void };
type Opts = {
  canRead: boolean;
  follow: () => Follow | null;
  onShow?: (wi: number, sent: [number, number], words: Word[]) => void;
};

export function useReadEngine(o: Opts) {
  const opts = useRef(o);
  opts.current = o;
  const [playing, setPlaying] = useState(false);
  const [wpm, setWpm] = useState(() => pref.get('reader.wpm', 260));
  const [started, setStarted] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const eng = useRef({ words: [] as Word[], sents: [] as [number, number][], wi: 0, timer: 0, playing: false, wpm });

  const sentOf = (i: number) => eng.current.sents.find(([a, b]) => i >= a && i <= b) ?? ([i, i] as [number, number]);
  const delay = (t: string) => {
    let d = 60000 / eng.current.wpm;
    if (END.test(t)) d *= 2.2;
    else if (/[,;:—]$/.test(t)) d *= 1.5;
    if (t.length > 8) d *= 1.25;
    return d;
  };
  const clearMarks = () => {
    if (owner && owner !== eng.current) return;
    hNow?.clear();
    hSent?.clear();
    owner = null;
  };

  const showWord = (i: number) => {
    const e = eng.current;
    if (!e.words.length) return;
    e.wi = Math.max(0, Math.min(e.words.length - 1, i));
    const w = e.words[e.wi];
    setStarted(true);
    setAtEnd(e.wi >= e.words.length - 1);
    const [a, b] = sentOf(e.wi);
    if (HL) {
      owner = e;
      hNow!.clear();
      hNow!.add(w.r);
      hSent!.clear();
      const sr = new Range();
      sr.setStart(e.words[a].r.startContainer, e.words[a].r.startOffset);
      sr.setEnd(e.words[b].r.endContainer, e.words[b].r.endOffset);
      hSent!.add(sr);
    }
    opts.current.onShow?.(e.wi, [a, b], e.words);
    const f = opts.current.follow();
    if (f) {
      const r = w.r.getBoundingClientRect();
      const S = f.el.getBoundingClientRect();
      if (r.bottom > S.top + S.height * f.low || r.top < S.top + f.top) {
        f.before?.();
        f.el.scrollBy({ top: r.top - (S.top + S.height * f.to), behavior: reduceMotion() ? 'auto' : 'smooth' });
      }
    }
  };

  const stop = () => {
    const e = eng.current;
    e.playing = false;
    clearTimeout(e.timer);
    setPlaying(false);
  };
  const tick = () => {
    const e = eng.current;
    if (!e.playing) return;
    if (e.wi >= e.words.length - 1) return stop();
    showWord(e.wi + 1);
    readTick(END.test(e.words[e.wi].t));
    e.timer = window.setTimeout(tick, delay(e.words[e.wi].t));
  };
  const play = () => {
    const e = eng.current;
    if (!opts.current.canRead || !e.words.length) return;
    if (e.wi >= e.words.length - 1) e.wi = 0;
    e.playing = true;
    setPlaying(true);
    showWord(e.wi);
    e.timer = window.setTimeout(tick, delay(e.words[e.wi].t));
  };
  const toggle = () => (eng.current.playing ? stop() : play());
  // Jumps keep a running read going from the new word.
  const jump = (i: number) => {
    const e = eng.current;
    showWord(i);
    if (e.playing) {
      clearTimeout(e.timer);
      e.timer = window.setTimeout(tick, delay(e.words[e.wi].t));
    }
  };
  const sentence = (dir: 1 | -1) => {
    const e = eng.current;
    if (!e.words.length) return;
    const [a, b] = sentOf(e.wi);
    jump(dir > 0 ? Math.min(e.words.length - 1, b + 1) : sentOf(Math.max(0, a - 1))[0]);
  };
  const speed = (d: number) => {
    const v = Math.max(120, Math.min(600, eng.current.wpm + d));
    eng.current.wpm = v;
    setWpm(v);
    pref.set('reader.wpm', v);
  };

  // Ranges only hold on settled text, so the words are rebuilt whenever it changes.
  const reset = (root: Element | null) => {
    const e = eng.current;
    stop();
    clearMarks();
    e.wi = 0;
    setStarted(false);
    setAtEnd(false);
    const built = opts.current.canRead && root ? wordsOf(root) : { words: [], sents: [] };
    e.words = built.words;
    e.sents = built.sents;
  };
  const dispose = () => {
    eng.current.playing = false;
    clearTimeout(eng.current.timer);
    clearMarks();
  };

  // The word under a click; a drag that selects text is left alone.
  const wordAt = (x: number, y: number) => (getSelection()?.isCollapsed ? wordIndexAt(eng.current.words, x, y) : -1);

  return { eng, playing, wpm, started, atEnd, sentOf, showWord, play, stop, toggle, jump, sentence, speed, reset, dispose, wordAt };
}
