import { useEffect, useState } from 'react';

// Replay pages as composed documents. Light on purpose: the replay card in the conversation needs it, the viewer loads lazily.

// The replay mod's base page CSS, minus its fixed-canvas height and overflow lock, so a page keeps its natural height.
const BASE_CSS = `:root{color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:#ffffff;color:#1a1a1a}
body{padding:16px;font:18px/1.45 "Atkinson Hyperlegible",system-ui,sans-serif}
code{overflow-wrap:anywhere}`;

// Inside the sandboxed page: reports its height, hands the viewer's keys back (a focused frame swallows them)
// and reports text selections, since the opaque frame is the only one that can read them.
const BRIDGE = `(()=>{const post=m=>parent.postMessage(Object.assign({replay:1},m),'*');
const size=()=>{const b=document.body;if(b)post({h:Math.max(b.scrollHeight,document.documentElement.getBoundingClientRect().height)})};
addEventListener('DOMContentLoaded',()=>{size();new ResizeObserver(size).observe(document.body)});addEventListener('load',size);
addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey||e.target.closest?.('input,textarea,select,[contenteditable]'))return;
if(['n','p','r','Escape','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();post({key:e.key})}},true);
let st=0;document.addEventListener('selectionchange',()=>{clearTimeout(st);st=setTimeout(()=>{const s=getSelection();const t=s&&!s.isCollapsed&&s.rangeCount?s.toString().trim():'';
if(!t)return post({sel:''});const g=s.getRangeAt(0);const rs=[...g.getClientRects()].filter(r=>r.width>0);const r=rs[rs.length-1]||g.getBoundingClientRect();
post({sel:t.slice(0,8000),x:r.right,y:r.bottom})},150)});
addEventListener('message',e=>{if(e.source===parent&&e.data&&e.data.replayClear)getSelection().removeAllRanges()})})()`;

// Composed pages by URL; the oldest drop first.
const DOCS_MAX = 40;
const docs = new Map<string, Promise<string>>();

function compose(html: string, base: string) {
  const head = `<meta charset="utf-8"><base href="${base.replace(/"/g, '%22')}"><style>${BASE_CSS}</style><script>${BRIDGE}</script>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${head}`);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

// A page's HTML wrapped like the mod's renderer does, with relative URLs still resolving to the manifest folder.
export function pageDoc(url: string) {
  let doc = docs.get(url);
  if (!doc) {
    doc = fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`The page did not load (HTTP ${r.status})`))))
      .then((html) => compose(html, new URL(url, location.href).href));
    doc.catch(() => docs.delete(url));
    docs.set(url, doc);
    while (docs.size > DOCS_MAX) docs.delete(docs.keys().next().value!);
  }
  return doc;
}

export function usePageDoc(url: string | undefined) {
  const [doc, setDoc] = useState<{ url: string; html?: string; error?: string }>();
  useEffect(() => {
    if (!url) return;
    let live = true;
    pageDoc(url).then(
      (html) => live && setDoc({ url, html }),
      (e: Error) => live && setDoc({ url, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return doc?.url === url ? doc : undefined;
}
