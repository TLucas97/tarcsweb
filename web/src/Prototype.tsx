import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ROUND_CANCELLED, type ProtoAnswer, type RichDetail } from '../../server/protocol.ts';
import { pickChoiceLocal, useStore, type RichItem } from './store.ts';
import { send } from './socket.ts';
import { watchNear } from './near.ts';
import { compose, useFit } from './frameDoc.ts';
import { fenced, SendTextBtn } from './SendToChat.tsx';

type Detail = Extract<RichDetail, { kind: 'prototype' }>;
type Values = Record<string, unknown>;

// Runs in the page before its own scripts: reads named controls, keeps window.proto.set values, and answers the card.
// Every change is also reported as a draft, so a remounted card can restore what the user had set.
const BRIDGE = `<script>(()=>{
const own={},SKIP=/^(button|submit|reset|image|file)$/;let timer=0;
const each=(f)=>{for(const el of document.querySelectorAll('input[name],select[name],textarea[name]')){const t=(el.type||'').toLowerCase();if(!SKIP.test(t))f(el,t)}};
const read=()=>{const out={};each((el,t)=>{const k=el.name;
if(t==='radio'){if(el.checked)out[k]=el.value;else if(!(k in out))out[k]=null}
else if(t==='checkbox')out[k]=el.checked;
else if(t==='range'||t==='number')out[k]=Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null;
else out[k]=el.value});return Object.assign(out,own)};
const post=(op)=>parent.postMessage({proto:1,op,values:read()},'*');
const soon=()=>{clearTimeout(timer);timer=setTimeout(()=>post('draft'),200)};
window.proto={set(k,v){try{own[String(k)]=v===undefined?null:JSON.parse(JSON.stringify(v))}catch{return}soon()},get:(k)=>own[String(k)]};
addEventListener('input',soon,true);addEventListener('change',soon,true);
addEventListener('message',(e)=>{const d=e.data;if(e.source!==parent||!d||d.proto!==1)return;
if(d.op==='collect')post('values');
if(d.op==='restore'&&d.values){const v=d.values,seen=new Set();each((el,t)=>{const k=el.name;if(!(k in v))return;const x=v[k];
if(t==='radio')el.checked=el.value===x;else if(t==='checkbox')el.checked=x===true;else el.value=x==null?'':String(x);
seen.add(k);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});
for(const k in v)if(!seen.has(k))own[k]=v[k]}});
})()</script>`;

// How long Send waits for the page's answer before falling back to its last draft.
const COLLECT_MS = 1500;
// Unsent values and notes survive a remount or session switch; dropped on send, oldest first past the cap.
const drafts = new Map<string, { values: Values | null; note: string }>();
const DRAFTS_MAX = 20;
const VALUE_SHOWN = 200;

const cancelled = (e: string) => e === ROUND_CANCELLED || /interrupt/i.test(e);
const isObj = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);
const shown = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? 'null';
  return s.length > VALUE_SHOWN ? `${s.slice(0, VALUE_SHOWN)}…` : s;
};

function remember(id: string, patch: Partial<{ values: Values | null; note: string }>) {
  const next = { values: null, note: '', ...drafts.get(id), ...patch };
  drafts.delete(id);
  drafts.set(id, next);
  if (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value!);
}

// One window listener for every prototype card; each frame's messages go to its own card, matched by event.source.
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

// The page's HTML, then the values as JSON and the note.
function protoText(d: Detail, answer: ProtoAnswer | null, label: string, note: string) {
  const head = `Prototype "${d.title || 'Prototype'}"${d.question ? ` (${d.question})` : ''}:\n${fenced(d.html, 'html')}`;
  const values = answer && Object.keys(answer.values).length ? `\n\n${label}:\n${fenced(JSON.stringify(answer.values, null, 2), 'json')}` : `\n\n${label}: none`;
  return `${head}${values}${note ? `\n\nNote: ${note}` : ''}`;
}

// What the frozen card lists under the frame: each value sent, the note, or why nothing was.
function Sent({ answer, error, fresh }: { answer: ProtoAnswer | null; error: string | null; fresh: boolean }) {
  if (error) return <div className="pro-sent"><span className={cancelled(error) ? 'pro-none' : 'pro-err'}>{cancelled(error) ? 'Prototype cancelled' : error}</span></div>;
  const keys = answer ? Object.keys(answer.values) : [];
  if (!answer || (!keys.length && !answer.note)) return <div className={`pro-sent${fresh ? ' in' : ''}`}><span className="pro-none">Closed to reply in chat</span></div>;
  return (
    <div className={`pro-sent${fresh ? ' in' : ''}`}>
      {keys.map((k) => (
        <div key={k} className="pro-kv">
          <span className="mono">{k}</span> <span className="pro-to" aria-hidden="true">→</span> <b className="mono">{shown(answer.values[k])}</b>
        </div>
      ))}
      {answer.dropped?.length ? <div className="pro-none">Too large to send: {answer.dropped.join(', ')}</div> : null}
      {answer.note && <div className="pro-note">{answer.note}</div>}
    </div>
  );
}

// ask_prototype: a live page the user tunes, then sends; the card freezes and lists what was sent.
export function Prototype({ item }: { item: RichItem }) {
  const d = item.detail as Detail;
  const sessionId = useStore((s) => s.current);
  const [ref, k] = useFit(d.width);
  const frame = useRef<HTMLIFrameElement>(null);
  const want = useRef<((v: Values) => void) | null>(null);
  const [note, setNote] = useState(() => drafts.get(item.id)?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [near, setNear] = useState(false);
  const r = item.result;
  const frozen = !!r;
  const ready = !item.partial && !!d.html;

  // Each iframe is a document of its own: load it only near the viewport, then keep it.
  useEffect(() => {
    if (!ready || near) return;
    return watchNear(ref.current!, () => setNear(true));
  }, [ready, near, ref]);

  useEffect(() => {
    const win = near ? frame.current?.contentWindow : null;
    if (!win) return;
    return listen(win, (op, values) => {
      if (op === 'values') want.current?.(values);
      else if (op === 'draft' && !frozen) remember(item.id, { values });
    });
  }, [near, frozen, item.id]);

  // A remounted or reloaded page starts from its defaults; this puts back what the user had set or sent.
  const restore = () => {
    const values = r ? (r.proto?.values ?? null) : (drafts.get(item.id)?.values ?? null);
    if (values && Object.keys(values).length) frame.current?.contentWindow?.postMessage({ proto: 1, op: 'restore', values }, '*');
  };

  const collect = () =>
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
    });

  // Empty values and note tell the model to stop and wait for a chat message.
  const submit = async (skip = false) => {
    if (item.partial || !sessionId || busy || frozen) return;
    let values: Values = {};
    if (!skip) {
      setBusy(true);
      values = (await collect()) ?? drafts.get(item.id)?.values ?? {};
      setBusy(false);
    }
    const text = skip ? '' : note.trim();
    if (!send({ type: 'proto-answer', sessionId, id: item.id, values, note: text })) return;
    drafts.delete(item.id);
    setFresh(true);
    pickChoiceLocal(item.id, { values, note: text });
  };
  const onKey = (e: KeyboardEvent) => {
    // Keeps Enter here from also answering a permission or sending the composer.
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) void submit();
  };

  // Attaches the page and its values to the composer only; the tool call stays open.
  const toChat = async () => {
    if (r) return protoText(d, r.proto ?? null, 'Sent values', r.proto?.note ?? '');
    const values = (near ? await collect() : null) ?? drafts.get(item.id)?.values ?? null;
    return protoText(d, values ? { values, note: '' } : null, 'Current values', note.trim());
  };

  return (
    <div className={`frame pro${frozen ? ' done' : ''}`} data-id={item.id} ref={ref}>
      <div className="fh">
        <span className="tool mono">prototype</span><span className="n">{d.title || 'Prototype'}</span>
        {ready && <SendTextBtn text={toChat} what="the prototype and its values" />}
      </div>
      {d.question && <p className="pro-q">{d.question}</p>}
      <div className="vbox" style={{ width: d.width * k, height: d.height * k }} inert={frozen}>
        {ready && near ? (
          <iframe
            ref={frame} className="live-vis" sandbox="allow-scripts" title={d.title || 'Prototype'} srcDoc={compose(d.html, d.title, true, BRIDGE)}
            width={d.width} height={d.height} onLoad={restore}
            style={{ ...(k < 1 ? { transform: `scale(${k})`, transformOrigin: '0 0' } : {}), ...(frozen ? {} : { pointerEvents: 'auto' }) }}
          />
        ) : (
          <div className="vmsg"><span className="think">Loading…</span></div>
        )}
      </div>
      {frozen ? (
        <Sent answer={r.error ? null : (r.proto ?? null)} error={r.error} fresh={fresh} />
      ) : (
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
      )}
    </div>
  );
}
