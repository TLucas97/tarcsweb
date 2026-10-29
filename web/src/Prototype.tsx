import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { PROTO_COMMENT_LEN, PROTO_COMMENTS_MAX, ROUND_CANCELLED, type ProtoAnswer, type ProtoComment, type RichDetail } from '../../server/protocol.ts';
import { pickChoiceLocal, useStore, type RichItem } from './store.ts';
import { send } from './socket.ts';
import { watchNear } from './near.ts';
import { compose, useFit } from './frameDoc.ts';
import { fenced, SendTextBtn } from './SendToChat.tsx';
import { FxBtn } from './Focus.tsx';
import { pauseOffscreen } from './perf.ts';

type Detail = Extract<RichDetail, { kind: 'prototype' }>;
type Values = Record<string, unknown>;
// A comment with the page it sits on (the variant's index, 0 for a single page).
type Pin = ProtoComment & { page: number };

// Runs in the page before its own scripts: reads named controls, keeps window.proto.set values, and answers the card.
// Every change is also reported as a draft, so a remounted card can restore what the user had set.
// A srcdoc page resolves links against the app's URL, so links and form submits are kept from navigating the frame away.
// Pick mode outlines the element under the pointer and reports the clicked one; pins are numbered badges over their elements.
const BRIDGE = `<script>(()=>{
const own={},SKIP=/^(button|submit|reset|image|file)$/,UI='data-proto-ui';let timer=0,picking=false,hl=null,pins=[],raf=0;
const each=(f)=>{for(const el of document.querySelectorAll('input[name],select[name],textarea[name]')){const t=(el.type||'').toLowerCase();if(!SKIP.test(t))f(el,t)}};
const read=()=>{const out={};each((el,t)=>{const k=el.name;
if(t==='radio'){if(el.checked)out[k]=el.value;else if(!(k in out))out[k]=null}
else if(t==='checkbox')out[k]=el.checked;
else if(t==='range'||t==='number')out[k]=Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null;
else out[k]=el.value});return Object.assign(out,own)};
const post=(op,values)=>parent.postMessage({proto:1,op,values:values||read()},'*');
const soon=()=>{clearTimeout(timer);timer=setTimeout(()=>post('draft'),200)};
window.proto={set(k,v){try{own[String(k)]=v===undefined?null:JSON.parse(JSON.stringify(v))}catch{return}soon()},get:(k)=>own[String(k)]};
addEventListener('input',soon,true);addEventListener('change',soon,true);
const mine=(el)=>!el||!el.closest||!!el.closest('['+UI+']')||el===document.documentElement||el===document.body;
const box=()=>{if(!hl){hl=document.createElement('div');hl.setAttribute(UI,'');hl.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #b7841f;border-radius:3px;background:rgba(183,132,31,.1);display:none';document.documentElement.appendChild(hl)}return hl};
const sel=(el)=>{const p=[];let e=el;for(;e&&e.nodeType===1&&e!==document.body;e=e.parentElement){if(e.id){p.unshift('#'+CSS.escape(e.id));break}let s=e.tagName.toLowerCase();const sib=e.parentElement?[...e.parentElement.children].filter((x)=>x.tagName===e.tagName):[e];if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(e)+1)+')';p.unshift(s)}if(e===document.body)p.unshift('body');const s=p.join(' > ');return s.length>4000?s.slice(s.indexOf(' > ',s.length-4000)+3):s};
const desc=(el)=>{const t=el.tagName.toLowerCase(),c=typeof el.className==='string'?el.className.trim().split(/\\s+/)[0]:'';const x=(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('alt')||'').replace(/\\s+/g,' ').trim();return ('<'+t+(c?'.'+c:'')+'>'+(x?' "'+(x.length>60?x.slice(0,60)+'…':x)+'"':'')).slice(0,300)};
const pick=(on)=>{picking=on;document.documentElement.style.cursor=on?'crosshair':'';if(!on&&hl)hl.style.display='none'};
addEventListener('mouseover',(e)=>{if(!picking)return;const el=e.target,b=box();if(mine(el)){b.style.display='none';return}const r=el.getBoundingClientRect();b.style.display='block';b.style.left=r.left+'px';b.style.top=r.top+'px';b.style.width=r.width+'px';b.style.height=r.height+'px'},true);
for(const n of ['pointerdown','mousedown','pointerup','mouseup'])addEventListener(n,(e)=>{if(picking){e.preventDefault();e.stopPropagation()}},true);
addEventListener('click',(e)=>{if(!picking)return;e.preventDefault();e.stopPropagation();const el=e.target;if(mine(el))return;pick(false);post('pin',{on:desc(el),selector:sel(el)})},true);
addEventListener('keydown',(e)=>{if(picking&&e.key==='Escape'){pick(false);post('unpick',{})}},true);
const draw=()=>{for(const b of document.querySelectorAll('[data-proto-pin]'))b.remove();for(const p of pins){let el=null;try{el=document.querySelector(p.selector)}catch{}if(!el)continue;const r=el.getBoundingClientRect(),b=document.createElement('div');b.setAttribute(UI,'');b.setAttribute('data-proto-pin','');b.textContent=String(p.n);
b.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#9b6e16;color:#fff;font:600 11px/18px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;left:'+Math.max(0,r.left-6)+'px;top:'+Math.max(0,r.top-6)+'px';document.documentElement.appendChild(b)}};
const later=()=>{if(!pins.length)return;cancelAnimationFrame(raf);raf=requestAnimationFrame(draw)};
addEventListener('resize',later);addEventListener('scroll',later,true);addEventListener('DOMContentLoaded',()=>new ResizeObserver(later).observe(document.body));
addEventListener('click',(e)=>{const a=e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented)return;e.preventDefault();const h=a.getAttribute('href')||'';const t=h.startsWith('#')&&h.length>1&&document.getElementById(decodeURIComponent(h.slice(1)));if(t)t.scrollIntoView()});
addEventListener('submit',(e)=>e.preventDefault());
parent.postMessage({proto:1,op:'hello',values:{}},'*');
addEventListener('message',(e)=>{const d=e.data;if(e.source!==parent||!d||d.proto!==1)return;
if(d.op==='collect')post('values');
if(d.op==='pick')pick(!!d.on);
if(d.op==='pins'&&Array.isArray(d.pins)){pins=d.pins;draw()}
if(d.op==='restore'&&d.values){const v=d.values,seen=new Set();each((el,t)=>{const k=el.name;if(!(k in v))return;const x=v[k];
if(t==='radio')el.checked=el.value===x;else if(t==='checkbox')el.checked=x===true;else el.value=x==null?'':String(x);
seen.add(k);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});
for(const k in v)if(!seen.has(k))own[k]=v[k]}});
})()</script>`;

// How long Send waits for the page's answer before falling back to its last draft.
const COLLECT_MS = 1500;
// Unsent values, notes, comments and picks survive a remount or session switch; dropped on send, oldest first past the cap.
type Draft = { values: Values | null; note: string; pins: Pin[]; variant: string | null };
const drafts = new Map<string, Draft>();
const DRAFTS_MAX = 40;
const VALUE_SHOWN = 200;
// Narrower widths the card offers, shown only when the canvas is wider.
const WIDTHS = [{ px: 390, label: '390', title: 'Phone width' }, { px: 768, label: '768', title: 'Tablet width' }];
// Space between variants and the height of each variant's label bar, in px.
const GAP = 8;
const BAR = 30;

const cancelled = (e: string) => e === ROUND_CANCELLED || /interrupt/i.test(e);
const isObj = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);
const shown = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? 'null';
  return s.length > VALUE_SHOWN ? `${s.slice(0, VALUE_SHOWN)}…` : s;
};
const pageKey = (id: string, page: number, many: boolean) => (many ? `${id}#${page}` : id);

function remember(id: string, patch: Partial<Draft>) {
  const next = { values: null, note: '', pins: [], variant: null, ...drafts.get(id), ...patch };
  drafts.delete(id);
  drafts.set(id, next);
  if (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value!);
}

// One window listener for every prototype page; each frame's messages go to its own page, matched by event.source.
type Port = (op: string, values: Values) => void;
const ports = new Map<MessageEventSource, Port>();
function onMessage(e: MessageEvent) {
  const port = e.source ? ports.get(e.source) : undefined;
  const d = e.data as { proto?: unknown; op?: unknown; values?: unknown } | null;
  if (port && d && d.proto === 1 && typeof d.op === 'string' && isObj(d.values)) port(d.op, d.values);
}
function listen(win: Window, port: Port) {
  if (!ports.size) window.addEventListener('message', onMessage);
  ports.set(win, port);
  return () => {
    ports.delete(win);
    if (!ports.size) window.removeEventListener('message', onMessage);
  };
}

// The page's HTML (each variant's), then the pick, values, comments and note.
function protoText(d: Detail, answer: ProtoAnswer | null, label: string) {
  const pages = d.variants?.length ? d.variants.map((v) => `Variant "${v.label}":\n${fenced(v.html, 'html')}`).join('\n\n') : fenced(d.html, 'html');
  const head = `Prototype "${d.title || 'Prototype'}"${d.question ? ` (${d.question})` : ''}:\n${pages}`;
  const picked = answer?.variant ? `\n\nPicked variant: ${answer.variant}` : '';
  const values = answer && Object.keys(answer.values).length ? `\n\n${label}:\n${fenced(JSON.stringify(answer.values, null, 2), 'json')}` : `\n\n${label}: none`;
  const comments = answer?.comments?.length
    ? `\n\nComments:\n${answer.comments.map((c, i) => `${i + 1}. ${c.variant ? `[${c.variant}] ` : ''}${c.on} (${c.selector}): ${c.text}`).join('\n')}`
    : '';
  return `${head}${picked}${values}${comments}${answer?.note ? `\n\nNote: ${answer.note}` : ''}`;
}

function CommentList({ pins, onRemove }: { pins: Pin[]; onRemove?: (i: number) => void }) {
  return (
    <ol className="pro-cms">
      {pins.map((p, i) => (
        <li key={i}>
          <span className="pro-cn" aria-hidden="true">{i + 1}</span>
          <span className="pro-ct">
            {p.variant && <span className="pro-cv">{p.variant}</span>}<span className="mono pro-on">{p.on}</span> {p.text}
          </span>
          {onRemove && (
            <button type="button" className="pro-cx" aria-label={`Remove comment ${i + 1}`} title="Remove" onClick={() => onRemove(i)}>×</button>
          )}
        </li>
      ))}
    </ol>
  );
}

// What the frozen card lists under the frame: the pick, each value sent, the comments, the note, or why nothing was.
function Sent({ answer, error, fresh, pins }: { answer: ProtoAnswer | null; error: string | null; fresh: boolean; pins: Pin[] }) {
  if (error) return <div className="pro-sent"><span className={cancelled(error) ? 'pro-none' : 'pro-err'}>{cancelled(error) ? 'Prototype cancelled' : error}</span></div>;
  const keys = answer ? Object.keys(answer.values) : [];
  if (!answer || (!keys.length && !answer.note && !answer.variant && !pins.length)) return <div className={`pro-sent${fresh ? ' in' : ''}`}><span className="pro-none">Closed to reply in chat</span></div>;
  return (
    <div className={`pro-sent${fresh ? ' in' : ''}`}>
      {answer.variant && <div className="pro-kv">Picked <b>{answer.variant}</b></div>}
      {keys.map((k) => (
        <div key={k} className="pro-kv">
          <span className="mono">{k}</span> <span className="pro-to" aria-hidden="true">→</span> <b className="mono">{shown(answer.values[k])}</b>
        </div>
      ))}
      {answer.dropped?.length ? <div className="pro-none">Too large to send: {answer.dropped.join(', ')}</div> : null}
      {pins.length ? <CommentList pins={pins} /> : null}
      {answer.note && <div className="pro-note">{answer.note}</div>}
    </div>
  );
}

type PageApi = { collect: () => Promise<Values | null> };

// One live page of the card: its frame, bridge port, restore after a reload, and the badges of its comments.
function ProtoPage({ html, title, frozen, restoreValues, pins, picking, onDraft, onPin, onUnpick, onApi }: {
  html: string; title: string; frozen: boolean; restoreValues: () => Values | null; pins: { n: number; selector: string }[]; picking: boolean;
  onDraft: (values: Values) => void; onPin: (on: string, selector: string) => void; onUnpick: () => void; onApi: (api: PageApi | null) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const want = useRef<((v: Values) => void) | null>(null);
  // gen remounts the frame; lost: it kept leaving its own page, so the card stops reloading it and says so.
  const [gen, setGen] = useState(0);
  const [lost, setLost] = useState(false);
  const hello = useRef(false);
  const latest = useRef({ onDraft, onPin, onUnpick, onApi, pins, picking });
  useEffect(() => {
    latest.current = { onDraft, onPin, onUnpick, onApi, pins, picking };
  });

  // A layout effect, so the listener is up before the new page's bridge says hello.
  useLayoutEffect(() => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    return listen(win, (op, values) => {
      if (op === 'hello') hello.current = true;
      else if (op === 'values') want.current?.(values);
      else if (op === 'draft' && !frozen) latest.current.onDraft(values);
      else if (op === 'pin' && typeof values.on === 'string' && typeof values.selector === 'string') latest.current.onPin(values.on, values.selector);
      else if (op === 'unpick') latest.current.onUnpick();
    });
  }, [frozen, gen, lost]);

  const say = (msg: Values) => frame.current?.contentWindow?.postMessage({ proto: 1, ...msg }, '*');
  // Keyed by content: the card rebuilds the list on every render.
  const pinsKey = JSON.stringify(pins);
  useEffect(() => say({ op: 'pins', pins: JSON.parse(pinsKey) }), [pinsKey]);
  useEffect(() => say({ op: 'pick', on: picking }), [picking]);

  useEffect(() => {
    latest.current.onApi({
      collect: () =>
        new Promise<Values | null>((resolve) => {
          const win = frame.current?.contentWindow;
          if (!win) return resolve(null);
          const timer = setTimeout(() => {
            want.current = null;
            resolve(null);
          }, COLLECT_MS);
          want.current = (v) => {
            clearTimeout(timer);
            want.current = null;
            resolve(v);
          };
          win.postMessage({ proto: 1, op: 'collect' }, '*');
        }),
    });
    return () => latest.current.onApi(null);
  }, []);

  const reload = () => {
    hello.current = false;
    setLost(false);
    setGen((g) => g + 1);
  };

  // A remounted or reloaded page starts from its defaults; this puts back what the user had set or sent, and the badges.
  // A load with no hello is some other page (the frame navigated away): it gets the prototype back, twice at most.
  const restore = () => {
    if (!hello.current) {
      if (gen < 2) setGen((g) => g + 1);
      else setLost(true);
      return;
    }
    hello.current = false;
    const values = restoreValues();
    if (values && Object.keys(values).length) say({ op: 'restore', values });
    if (latest.current.pins.length) say({ op: 'pins', pins: latest.current.pins });
    if (latest.current.picking) say({ op: 'pick', on: true });
  };

  if (lost) return <div className="vmsg"><span>The prototype left its page.</span> <button type="button" className="opt" onClick={reload}>Reload it</button></div>;
  return (
    <iframe
      key={gen} ref={frame} className="live-vis" sandbox="allow-scripts" title={title} srcDoc={compose(html, title, true, BRIDGE)}
      onLoad={restore} style={frozen ? undefined : { pointerEvents: 'auto' }}
    />
  );
}

// ask_prototype: live pages the user tunes, comments on and picks from, then sends; the card freezes and lists what was sent.
export function Prototype({ item }: { item: RichItem }) {
  const d = item.detail as Detail;
  const sessionId = useStore((s) => s.current);
  const variants = d.variants?.length ? d.variants : null;
  const pages = variants ?? [{ label: '', html: d.html }];
  const many = !!variants;
  const r = item.result;
  const frozen = !!r;
  const ready = !item.partial && pages.every((p) => !!p.html);

  const [vw, setVw] = useState<number | null>(null);
  const pageW = vw ?? d.width;
  const total = pageW * pages.length + GAP * (pages.length - 1);
  const [ref, k] = useFit(total);
  // Each mounted page's collect, by page index; read only in handlers.
  const apis = useRef(new Map<number, PageApi>());
  // Bumped by the reload button: remounts every page, which then restores its draft.
  const [tick, setTick] = useState(0);

  const saved = drafts.get(item.id);
  const [note, setNote] = useState(() => saved?.note ?? '');
  const [pins, setPins] = useState<Pin[]>(() => saved?.pins ?? []);
  const [variant, setVariant] = useState<string | null>(() => saved?.variant ?? null);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<{ page: number; on: string; selector: string } | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [near, setNear] = useState(false);

  // A frozen card shows what was sent: its pick and its comments, placed on the page they were made on.
  const sentPins: Pin[] = r?.proto?.comments?.map((c) => ({ ...c, page: Math.max(0, pages.findIndex((p) => p.label === c.variant)) })) ?? [];
  const shownPins = frozen ? sentPins : pins;
  const shownVariant = frozen ? (r?.proto?.variant ?? null) : variant;

  // Each iframe is a document of its own: load them only near the viewport, then keep them.
  useEffect(() => {
    if (!ready || near) return;
    return watchNear(ref.current!, () => setNear(true));
  }, [ready, near, ref]);

  const setPinsSaved = (next: Pin[]) => {
    setPins(next);
    remember(item.id, { pins: next });
  };
  // The pins plus the comment still being typed, so Send never drops it.
  const withPending = (): Pin[] => {
    const text = pendingText.trim();
    return pending && text ? [...pins, { ...pending, text, ...(many ? { variant: pages[pending.page].label } : {}) }].slice(0, PROTO_COMMENTS_MAX) : pins;
  };
  const addPending = () => {
    if (!pending || !pendingText.trim()) return;
    setPinsSaved(withPending());
    setPending(null);
    setPendingText('');
  };
  const pickVariant = (label: string) => {
    const next = variant === label ? null : label;
    setVariant(next);
    remember(item.id, { variant: next });
  };

  // A variant's values come back as "label.key"; a page restores only its own. The longest label wins, so "v1" never takes "v1.2.speed".
  const sentValues = (page: number): Values | null => {
    const all = r?.proto?.values;
    if (!all) return null;
    if (!many) return all;
    const owner = (key: string) => pages.reduce((best, p, i) => (key.startsWith(`${p.label}.`) && (best < 0 || p.label.length > pages[best].label.length) ? i : best), -1);
    const pre = pages[page].label.length + 1;
    return Object.fromEntries(Object.entries(all).filter(([key]) => owner(key) === page).map(([key, v]) => [key.slice(pre), v]));
  };

  const collectAll = async (): Promise<Values> => {
    const got = await Promise.all(pages.map((_, i) => apis.current.get(i)?.collect() ?? Promise.resolve(null)));
    const out: Values = {};
    got.forEach((v, i) => {
      const values = v ?? drafts.get(pageKey(item.id, i, many))?.values ?? {};
      for (const [key, x] of Object.entries(values)) out[many ? `${pages[i].label}.${key}` : key] = x;
    });
    return out;
  };

  // Empty values, note, pick and comments tell the model to stop and wait for a chat message.
  const submit = async (skip = false) => {
    if (item.partial || !sessionId || busy || frozen) return;
    let values: Values = {};
    if (!skip) {
      setBusy(true);
      values = await collectAll();
      setBusy(false);
    }
    const text = skip ? '' : note.trim();
    const comments: ProtoComment[] = skip ? [] : withPending().map(({ page: _, ...c }) => c);
    const picked = skip ? null : variant;
    if (!send({ type: 'proto-answer', sessionId, id: item.id, values, note: text, variant: picked, comments })) return;
    pages.forEach((_, i) => drafts.delete(pageKey(item.id, i, many)));
    drafts.delete(item.id);
    setPicking(false);
    setPending(null);
    setFresh(true);
    pickChoiceLocal(item.id, { values, note: text, ...(picked ? { variant: picked } : {}), ...(comments.length ? { comments } : {}) });
  };
  const onKey = (e: KeyboardEvent) => {
    // Keeps Enter here from also answering a permission or sending the composer.
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) void submit();
  };
  const onPendingKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') (e.preventDefault(), addPending());
    if (e.key === 'Escape') (e.preventDefault(), setPending(null));
  };

  // Attaches the page and its values to the composer only; the tool call stays open.
  const toChat = async () => {
    if (r) return protoText(d, r.proto ? { ...r.proto } : null, 'Sent values');
    const values = near ? await collectAll() : null;
    const comments = pins.map(({ page: _, ...c }) => c);
    return protoText(d, { values: values ?? {}, note: note.trim(), ...(variant ? { variant } : {}), ...(comments.length ? { comments } : {}) }, 'Current values');
  };

  const live = ready && near;
  const boxStyle = { width: total * k, height: d.height + (many ? BAR : 0), '--pw': `${total}px` } as CSSProperties;
  const widths = WIDTHS.filter((w) => w.px < d.width);

  return (
    <div className={`frame pro${frozen ? ' done' : ''}`} data-id={item.id} data-fx-real="" ref={ref}>
      <div className="fh">
        <span className="tool mono">prototype</span><span className="n">{d.title || 'Prototype'}</span>
        {live && widths.length > 0 && (
          <span className="pro-ws" role="group" aria-label="Page width">
            {[...widths, { px: 0, label: 'Full', title: 'Canvas width' }].map((w) => {
              const on = (vw ?? 0) === w.px;
              return (
                <button key={w.px} type="button" className={`pro-w${on ? ' on' : ''}`} aria-pressed={on} title={w.title} onClick={() => setVw(w.px || null)}>{w.label}</button>
              );
            })}
          </span>
        )}
        {live && (
          <button type="button" className="fx-btn" title="Reload, keeping the values set" aria-label="Reload the prototype" onClick={() => setTick((t) => t + 1)}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" /></svg>
          </button>
        )}
        {live && !frozen && (
          <button
            type="button" className={`fx-btn${picking ? ' on' : ''}`} aria-pressed={picking} aria-label="Comment on a part of the prototype"
            title={pins.length >= PROTO_COMMENTS_MAX ? `${PROTO_COMMENTS_MAX} comments max` : 'Comment on a part of the prototype'}
            disabled={!picking && pins.length >= PROTO_COMMENTS_MAX}
            onClick={() => (setPending(null), setPicking((p) => !p))}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>
          </button>
        )}
        {live && <FxBtn label={d.title || 'Prototype'} />}
        {ready && <SendTextBtn text={toChat} what="the prototype and its values" />}
      </div>
      {d.question && <p className="pro-q">{d.question}</p>}
      {d.placeholders && <p className="pro-ph"><span className="pro-tag">Not final</span> {d.placeholders}</p>}
      {picking && (
        <div className="pro-hint">
          <span>Click a part of the prototype to comment on it.</span>
          <button type="button" className="opt" onClick={() => setPicking(false)}>Cancel</button>
        </div>
      )}
      {/* Never scaled: a narrow column gives each page less width at 1:1, so its text stays sharp. Full screen widens it to the canvas. */}
      <div className={`vbox pro-box${many ? ' many' : ''}`} style={boxStyle} inert={frozen}>
        {!live ? (
          <div className="vmsg"><span className="think" ref={pauseOffscreen}>Loading…</span></div>
        ) : (
          pages.map((p, i) => {
            const page = (
              <ProtoPage
                key={`${i}:${tick}`} html={p.html} title={p.label || d.title || 'Prototype'} frozen={frozen}
                onApi={(api) => (api ? apis.current.set(i, api) : apis.current.delete(i))}
                restoreValues={() => (frozen ? sentValues(i) : (drafts.get(pageKey(item.id, i, many))?.values ?? null))}
                pins={shownPins.flatMap((c, n) => (c.page === i ? [{ n: n + 1, selector: c.selector }] : []))}
                picking={picking}
                onDraft={(values) => remember(pageKey(item.id, i, many), { values })}
                onPin={(on, selector) => (setPicking(false), setPendingText(''), setPending({ page: i, on, selector }))}
                onUnpick={() => setPicking(false)}
              />
            );
            if (!many) return page;
            const on = shownVariant === p.label;
            return (
              <div key={i} className={`pro-v${on ? ' on' : ''}`}>
                <button type="button" className="pro-vb" aria-pressed={on} disabled={frozen} onClick={() => pickVariant(p.label)}>
                  <span className="pro-vl">{p.label}</span>
                  <span className="pro-vp">{on ? 'Picked' : 'Pick'}</span>
                </button>
                {page}
              </div>
            );
          })
        )}
      </div>
      {pending && !frozen && (
        <div className="pro-pend" onKeyDown={onPendingKey}>
          <span className="pro-pon">Comment on {many && <span className="pro-cv">{pages[pending.page].label}</span>}<span className="mono pro-on">{pending.on}</span></span>
          <input className="aqo pro-nt" aria-label="Comment" placeholder="What should change here?" value={pendingText} maxLength={PROTO_COMMENT_LEN.text} autoFocus onChange={(e) => setPendingText(e.target.value)} />
          <span className="rnd-acts">
            <button type="button" className="opt" onClick={() => setPending(null)}>Cancel</button>
            <button type="button" className="go2" disabled={!pendingText.trim()} onClick={addPending}>Add</button>
          </span>
        </div>
      )}
      {frozen ? (
        <Sent answer={r.error ? null : (r.proto ?? null)} error={r.error} fresh={fresh} pins={sentPins} />
      ) : (
        <>
          {pins.length > 0 && <div className="pro-sent"><CommentList pins={pins} onRemove={(i) => setPinsSaved(pins.filter((_, j) => j !== i))} /></div>}
          <form className="cf pro-cf" onSubmit={(e) => (e.preventDefault(), void submit())} onKeyDown={onKey}>
            <input
              className="aqo pro-nt" aria-label="Note" placeholder="Note (optional)" value={note}
              onChange={(e) => (setNote(e.target.value), remember(item.id, { note: e.target.value }))}
            />
            <span className="rnd-acts">
              <button type="button" className="opt" disabled={item.partial || busy} onClick={() => void submit(true)}>Reply in chat</button>
              <button className="go2" type="submit" disabled={item.partial || busy || !near} data-robot-react="happy">Send<kbd aria-hidden="true">Ctrl ↵</kbd></button>
            </span>
          </form>
        </>
      )}
    </div>
  );
}
