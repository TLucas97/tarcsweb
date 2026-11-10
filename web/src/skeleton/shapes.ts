import DOMPurify from 'dompurify';

// A skeleton's shape remembered from the last visit (after skullet). Kept apart from Reveal.tsx so first-paint screens never load DOMPurify.
export type Shape = { read: () => string | null; write: (el: HTMLElement) => void };

const STORE = 'cw:skl1:';
const SHAPE_MAX = 20_000;
const STRIP = ['id', 'title', 'aria-label', 'aria-controls', 'href', 'value', 'placeholder', 'name', 'for'];

// One localStorage entry per name. Shapes keep layout, never content: letters and digits are replaced before the markup is stored.
export function shapeMemory(name: string): Shape {
  const key = STORE + name;
  return {
    read() {
      try {
        const html = localStorage.getItem(key);
        return html ? DOMPurify.sanitize(html) : null;
      } catch {
        return null;
      }
    },
    write(el) {
      const copy = el.cloneNode(true) as HTMLElement;
      const w = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode as Text;
        t.data = t.data.replace(/\p{Lu}/gu, 'X').replace(/\p{Ll}/gu, 'x').replace(/\d/g, '0');
      }
      for (const e of copy.querySelectorAll('*')) for (const a of STRIP) e.removeAttribute(a);
      const html = copy.innerHTML;
      try {
        if (html.length <= SHAPE_MAX) localStorage.setItem(key, html);
        else localStorage.removeItem(key);
      } catch {}
    },
  };
}
