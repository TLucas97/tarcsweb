import { heavy } from './perf.ts';

// Typed letters glow on a layer over the textarea, then fade out to reveal the text's own ink.
// Matches the .ink-layer span animation in styles.css.
const MS = 80;

type Ink = { at: number; len: number; t0: number };
export type InkTrail = { inks: Ink[]; text: string; timer: number };
export const newInkTrail = (): InkTrail => ({ inks: [], text: '', timer: 0 });

export function clearInk(s: InkTrail, layer: HTMLElement | null) {
  clearTimeout(s.timer);
  s.inks = [];
  s.text = '';
  layer?.replaceChildren();
}

// Any edit other than typing moves offsets, so the trail starts over.
export function inkInput(s: InkTrail, layer: HTMLElement | null, t: HTMLTextAreaElement, e: InputEvent) {
  if (!layer) return;
  if (e.inputType === 'insertCompositionText') return;
  if (e.inputType !== 'insertText' || !e.data || heavy()) return clearInk(s, layer);
  const now = performance.now();
  const len = e.data.length;
  const at = t.selectionStart - len;
  s.inks = s.inks.filter((k) => now - k.t0 < MS);
  for (const k of s.inks) if (k.at >= at) k.at += len;
  s.inks.push({ at, len, t0: now });
  s.inks.sort((a, b) => a.at - b.at);
  draw(s, layer, t, now);
}

// Text changed from code (send, recall, a draft switch): the trail no longer lines up.
export function inkSync(s: InkTrail, layer: HTMLElement | null, value: string) {
  if (s.inks.length && value !== s.text) clearInk(s, layer);
}

function draw(s: InkTrail, layer: HTMLElement, t: HTMLTextAreaElement, now: number) {
  const text = t.value;
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const k of s.inks) {
    if (k.at < pos || k.at + k.len > text.length) continue;
    frag.append(text.slice(pos, k.at));
    const el = document.createElement('span');
    el.textContent = text.slice(k.at, k.at + k.len);
    // A negative delay resumes each letter's fade where the last redraw left it.
    el.style.animationDelay = `${k.t0 - now}ms`;
    frag.append(el);
    pos = k.at + k.len;
  }
  frag.append(text.slice(pos) + '​');
  layer.replaceChildren(frag);
  layer.scrollTop = t.scrollTop;
  s.text = text;
  clearTimeout(s.timer);
  s.timer = window.setTimeout(() => clearInk(s, layer), MS);
}
