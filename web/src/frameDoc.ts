import { useWidth } from './ui/size.ts';

// The visual mod's base stylesheet, placed first so the agent's own CSS wins (same as its renderer).
const BASE_CSS = `:root{color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%;background:#ffffff;color:#1a1a1a;overflow:hidden}
body{padding:16px;font:18px/1.45 "Atkinson Hyperlegible",system-ui,sans-serif}`;
// An interactive page taller than the canvas scrolls inside the frame instead of passing the wheel to the chat.
const SCROLL_CSS = `html{overflow:auto;overscroll-behavior:contain}body{height:auto;min-height:100%;overflow:visible}`;

// A render_ui page as a full document; extra goes in the head before the page's own tags (ask_prototype's bridge).
export function compose(html: string, title: string, interactive?: boolean, extra = '') {
  const head = `<meta charset="utf-8"><title>${(title || 'visual').replace(/</g, '&lt;')}</title><style id="visual-base">${BASE_CSS}${interactive ? SCROLL_CSS : ''}</style>${extra}`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${head}`);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

// Scale that fits a fixed canvas into the conversation column.
export const colOf = (el: HTMLDivElement) => el.closest('.col');
export function useFit(width: number) {
  const [ref, cw] = useWidth(colOf);
  return [ref, cw > 0 ? Math.min(1, (cw - 2) / width) : 1] as const;
}
