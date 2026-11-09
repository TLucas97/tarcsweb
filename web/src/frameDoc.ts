import { useState } from 'react';
import { useWidth } from './ui/size.ts';
import { isDark, onTheme } from './theme.ts';

export type PageTheme = 'light' | 'dark';
export const pageTheme = (): PageTheme => (isDark() ? 'dark' : 'light');

// The colors model pages paint with (var(--bg) and the rest); the visual mod's renderer keeps the same values.
// :where() keeps them at zero specificity, so a page's own :root tokens or a project stylesheet still win.
export const PAGE_TOKENS = `:where(:root){color-scheme:light;--bg:#fff;--ink:#1d2520;--muted:#5f6561;--faint:#9aa19c;--line:#e4e4e0;--tint:#f4f2ef;--accent:#3b7a57;--bad:#9a4b3c}
:where(:root[data-theme=dark]){color-scheme:dark;--bg:#262420;--ink:#dcd7cc;--muted:#a09b8f;--faint:#7d786d;--line:#46433c;--tint:#32302a;--accent:#8fae8c;--bad:#d08a80}`;

// The visual mod's base stylesheet, placed first so the agent's own CSS wins (same as its renderer).
// A themed page paints with the tokens; an unthemed one keeps the old white base, which pages made before the tokens rely on.
const baseCss = (themed: boolean) => `${PAGE_TOKENS}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%;background:${themed ? 'var(--bg)' : '#ffffff'};color:${themed ? 'var(--ink)' : '#1a1a1a'};overflow:hidden}
body{padding:16px;font:18px/1.45 "Atkinson Hyperlegible",system-ui,sans-serif}`;
// An interactive page taller than the canvas scrolls inside the frame instead of passing the wheel to the chat.
const SCROLL_CSS = `html{overflow:auto;overscroll-behavior:contain}body{height:auto;min-height:100%;overflow:visible}`;

// Key events stay in the frame's document, so Esc is handed to the full-screen view; a page that handles Esc itself calls preventDefault.
const ESC_BRIDGE = `<script>addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented)parent.postMessage({fxEsc:1},'*')})</script>`;

// Sets the theme before first paint, then follows the host's toggles; it asks once on start, since its srcdoc may predate a toggle.
// Each change fires a window "themechange" event, so a canvas or chart that sampled the tokens can redraw.
export const themeHead = (t: PageTheme) =>
  `<script>(()=>{const r=document.documentElement,set=v=>{if((v==='dark'||v==='light')&&r.dataset.theme!==v){r.dataset.theme=v;dispatchEvent(new Event('themechange'))}};set('${t}');`
  + `addEventListener('message',e=>{if(e.source===parent&&e.data)set(e.data.fxTheme)});if(parent!==window)parent.postMessage({fxTheme:'?'},'*')})()</script>`;

const themedFrames = () => document.querySelectorAll<HTMLIFrameElement>('iframe[data-themed]');

// One listener for every themed frame: a toggle reaches the page by message, so no frame reloads.
// Only a mounted themed frame's own window gets an answer to its start-up ask.
addEventListener('message', (e) => {
  if (e.data?.fxTheme !== '?' || !e.source) return;
  for (const f of themedFrames()) if (f.contentWindow === e.source) return void f.contentWindow.postMessage({ fxTheme: pageTheme() }, '*');
});
onTheme(() => {
  const t = pageTheme();
  for (const f of themedFrames()) f.contentWindow?.postMessage({ fxTheme: t }, '*');
});

// Pages made before the tokens have a result without "theme: auto" and keep the light base; one still running follows the app.
export const followsTheme = (result: { theme?: 'auto' } | null) => !result || result.theme === 'auto';

// The theme a themed frame starts in, read once per mount, so a toggle never changes its srcdoc.
export function useStartTheme(themed: boolean): PageTheme | null {
  const [t] = useState(pageTheme);
  return themed ? t : null;
}

// A render_ui page as a full document; extra goes in the head before the page's own tags (ask_prototype's bridge).
// theme: the page follows the app's theme from that start; null keeps the light base.
export function compose(html: string, title: string, interactive?: boolean, extra = '', theme: PageTheme | null = null) {
  const head = `<meta charset="utf-8"><title>${(title || 'visual').replace(/</g, '&lt;')}</title><style id="visual-base">${baseCss(!!theme)}${interactive ? SCROLL_CSS : ''}</style>${theme ? themeHead(theme) : ''}${ESC_BRIDGE}${extra}`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${head}`);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// A browser tab page that centers a composed canvas and scales it to fit the window, up to 3x like the full-screen view.
export function canvasPage(doc: string, title: string, width: number, height: number, theme: PageTheme | null = null) {
  const t = attr(title || 'visual');
  const dark = theme === 'dark';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><style>html,body{margin:0;height:100%;overflow:hidden;background:${dark ? '#1e1d1a;color-scheme:dark' : '#f4f4f2'}}`
    + `iframe{position:absolute;left:50%;top:50%;border:0;background:${dark ? '#262420' : '#fff'};box-shadow:0 0 0 1px rgb(${dark ? '255 255 255' : '0 0 0'}/.08)}</style></head><body>`
    + `<iframe sandbox="allow-scripts" title="${t}" width="${width}" height="${height}" srcdoc="${attr(doc)}"></iframe>`
    + `<script>const f=document.querySelector('iframe');const fit=()=>{const k=Math.max(.1,Math.min(3,(innerWidth-48)/${width},(innerHeight-48)/${height}));`
    + `f.style.transform='translate(-50%,-50%) scale('+k+')'};addEventListener('resize',fit);fit()</script></body></html>`;
}

// Scale that fits a fixed canvas into the conversation column.
export const colOf = (el: HTMLDivElement) => el.closest('.col');
export function useFit(width: number) {
  const [ref, cw] = useWidth(colOf);
  return [ref, cw > 0 ? Math.min(1, (cw - 2) / width) : 1] as const;
}
