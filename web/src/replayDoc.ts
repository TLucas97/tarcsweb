import { useEffect, useState } from 'react';
import type { ReplayInfo, ReplayPng } from '../../server/protocol.ts';
import { PAGE_TOKENS, pageTheme, themeHead, type PageTheme } from './frameDoc.ts';

// Replay pages as composed documents. Light on purpose: the replay card in the conversation needs it, the viewer loads lazily.

// The replay mod's base page CSS, minus its fixed-canvas height and overflow lock, so a page keeps its natural height.
const BASE_CSS = `:root{color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:#ffffff;color:#1a1a1a}
body{padding:16px;font:18px/1.45 "Atkinson Hyperlegible",system-ui,sans-serif}
code{overflow-wrap:anywhere}`;
// A replay whose manifest opts in ("theme": "auto") paints with the page tokens, which follow the app's theme.
const THEMED_CSS = `${PAGE_TOKENS}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{padding:16px;font:18px/1.45 "Atkinson Hyperlegible",system-ui,sans-serif}
code{overflow-wrap:anywhere}`;

// Inside the sandboxed page: reports its height, hands the viewer's keys back (a focused frame swallows them; fields and
// key-owning widgets like a quiz or a figure's slider keep theirs) and reports text selections, which only the frame can read.
const BRIDGE = `(()=>{const post=m=>parent.postMessage(Object.assign({replay:1},m),'*');
const size=()=>{const b=document.body;if(b)post({h:Math.max(b.scrollHeight,document.documentElement.getBoundingClientRect().height)})};
addEventListener('DOMContentLoaded',()=>{size();new ResizeObserver(size).observe(document.body)});addEventListener('load',size);
addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey||e.target.closest?.('input,textarea,select,[contenteditable],[role=slider],[role=radiogroup],[role=tablist],[role=listbox],[role=spinbutton],[data-keys]'))return;
if(['n','p','r','Escape','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();post({key:e.key})}},true);
let st=0;document.addEventListener('selectionchange',()=>{clearTimeout(st);st=setTimeout(()=>{const s=getSelection();const t=s&&!s.isCollapsed&&s.rangeCount?s.toString().trim():'';
if(!t)return post({sel:''});const g=s.getRangeAt(0);const rs=[...g.getClientRects()].filter(r=>r.width>0);const r=rs[rs.length-1]||g.getBoundingClientRect();
post({sel:t.slice(0,8000),x:r.right,y:r.bottom})},150)});
addEventListener('message',e=>{if(e.source===parent&&e.data&&e.data.replayClear)getSelection().removeAllRanges()})})()`;

// Fetched pages by URL, before composing; the oldest drop first.
const DOCS_MAX = 40;
const docs = new Map<string, Promise<string>>();

function compose(html: string, base: string, theme: PageTheme | null) {
  const head = `<meta charset="utf-8"><base href="${base.replace(/"/g, '%22')}"><style>${theme ? THEMED_CSS : BASE_CSS}</style>${theme ? themeHead(theme) : ''}<script>${BRIDGE}</script>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${head}`);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

// A page's HTML wrapped like the mod's renderer does, with relative URLs still resolving to the manifest folder.
// theme: the theme a themed replay's page starts in; null keeps the light base.
export function pageDoc(url: string, theme: PageTheme | null = null) {
  let doc = docs.get(url);
  if (!doc) {
    doc = fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`The page did not load (HTTP ${r.status})`))));
    doc.catch(() => docs.delete(url));
    docs.set(url, doc);
    while (docs.size > DOCS_MAX) docs.delete(docs.keys().next().value!);
  }
  return doc.then((html) => compose(html, new URL(url, location.href).href, theme));
}

// The page's own URL for a browser tab; the server marks a themed replay's page dark when the app is dark now.
export const pageTabUrl = (url: string, themed: boolean) => new URL(themed && pageTheme() === 'dark' ? `${url}?theme=dark` : url, location.href).href;

export const pagePng = (pngs: ReplayPng[] | undefined, id: string) => pngs?.find((p) => p.id === id)?.png;

// "Whole replay" for the chat: the title, then each page with its picture path when the tool rendered one.
export function replayText(info: ReplayInfo, pngs: ReplayPng[] | undefined) {
  const lines = info.pages.map((p) => {
    const png = pagePng(pngs, p.id);
    return `- ${p.id} · ${p.title}${png ? `: ${png}` : ''}`;
  });
  return `Replay "${info.title}" (${info.pages.length} page${info.pages.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
}

// themed: the replay opted in; its page starts in the theme read here, and later toggles reach it by message.
export function usePageDoc(url: string | undefined, themed = false) {
  const [doc, setDoc] = useState<{ url: string; html?: string; error?: string }>();
  useEffect(() => {
    if (!url) return;
    let live = true;
    pageDoc(url, themed ? pageTheme() : null).then(
      (html) => live && setDoc({ url, html }),
      (e: Error) => live && setDoc({ url, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [url, themed]);
  return doc?.url === url ? doc : undefined;
}
