import { useEffect, useState, type RefObject } from 'react';
import { useEscape } from './bits.tsx';
import { END, HL, wordIndexAt, wordsOf } from './readEngine.ts';
import { readTick } from './Sounds.ts';

const hLens = HL ? new Highlight() : null;
const hSent = HL ? new Highlight() : null;
if (HL) {
  CSS.highlights.set('rd-lens', hLens!);
  CSS.highlights.set('rd-lens-sent', hSent!);
}
const FAST = 1;
const SETTLE = 120;
const clear = () => {
  hLens?.clear();
  hSent?.clear();
};

// Middle-click toggles the reading lens: the conversation dims, the sentence under the pointer lights and its word is marked.
export function useLens(ref: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    const conv = ref.current;
    if (!conv || !HL) return;
    // Links keep their middle-click (open in a new tab).
    const onDown = (e: MouseEvent) => {
      if (e.button !== 1 || (e.target as Element).closest('a,input,textarea,[contenteditable]')) return;
      e.preventDefault();
      setOn((v) => !v);
    };
    conv.addEventListener('mousedown', onDown);
    return () => conv.removeEventListener('mousedown', onDown);
  }, []);

  useEscape(on, () => setOn(false));

  useEffect(() => {
    const conv = ref.current;
    if (!on || !conv) return;
    conv.classList.add('lens');
    let x = -1;
    let y = -1;
    let frame = 0;
    // Smoothed pointer speed in px/ms; during a sweep past FAST the mark and the tick wait.
    let speed = 0;
    let at = 0;
    let settle = 0;
    // The word lit now; the first one lights silently, each new word after it ticks.
    let lit: Range | null = null;
    // Words of the hovered reply, rebuilt when the pointer moves to another one or its text grows.
    let cache: { say: Element; size: number } & ReturnType<typeof wordsOf> | null = null;
    const light = () => {
      frame = 0;
      if (speed >= FAST) return;
      const say = document.elementFromPoint(x, y)?.closest('.say');
      if (!say || !conv.contains(say)) return clear();
      const size = say.textContent!.length;
      if (cache?.say !== say || cache.size !== size) cache = { say, size, ...wordsOf(say) };
      // Between two words the last one stays lit, so the mark does not flicker.
      const i = wordIndexAt(cache.words, x, y);
      const s = cache.sents.find(([a, b]) => i >= a && i <= b);
      if (!s) return;
      const w = cache.words[i];
      if (w.r === lit) return;
      if (lit) readTick(END.test(w.t));
      lit = w.r;
      const r = new Range();
      r.setStart(cache.words[s[0]].r.startContainer, cache.words[s[0]].r.startOffset);
      r.setEnd(cache.words[s[1]].r.endContainer, cache.words[s[1]].r.endOffset);
      clear();
      hSent!.add(r);
      hLens!.add(cache.words[i].r);
    };
    const queue = () => {
      if (x >= 0 && !frame) frame = requestAnimationFrame(light);
    };
    const onMove = (e: PointerEvent) => {
      if (x >= 0) speed = speed * 0.6 + (Math.hypot(e.clientX - x, e.clientY - y) / Math.max(1, e.timeStamp - at)) * 0.4;
      x = e.clientX;
      y = e.clientY;
      at = e.timeStamp;
      // A sweep that stops sends no more moves, so the mark catches up once the pointer rests.
      clearTimeout(settle);
      if (speed >= FAST) settle = window.setTimeout(() => {
        speed = 0;
        queue();
      }, SETTLE);
      queue();
    };
    const onLeave = () => {
      x = -1;
      clear();
    };
    // A right-click that starts guided reading (bindInlineMenu, registered earlier) hands over from the lens.
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) setOn(false);
    };
    // A click anywhere but the text or the chip turns the lens off.
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element;
      if (e.button !== 0 || t.closest('.say,.lens-chip,:popover-open,dialog[open]')) return;
      setOn(false);
    };
    document.addEventListener('click', onClick);
    conv.addEventListener('pointermove', onMove);
    conv.addEventListener('pointerleave', onLeave);
    conv.addEventListener('scroll', queue, { passive: true });
    conv.addEventListener('contextmenu', onMenu);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      conv.removeEventListener('contextmenu', onMenu);
      document.removeEventListener('click', onClick);
      conv.removeEventListener('pointermove', onMove);
      conv.removeEventListener('pointerleave', onLeave);
      conv.removeEventListener('scroll', queue);
      conv.classList.remove('lens');
      clear();
    };
  }, [on]);

  return { on, off: () => setOn(false) };
}
