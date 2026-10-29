import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { BrowserFeedback, BrowserVideo } from '../../../server/protocol.ts';
import { drawEl } from '../board/render.ts';
import type { El, Pt } from '../board/types.ts';
import { attachFeedback } from '../SendToChat.tsx';
import './feedback.css';

type Tool = 'stroke' | 'arrow' | 'rect' | 'ellipse' | 'text';
const palette = { ink: '#e23d35', grid: '#fff', accent: '#e23d35' };

export default function Feedback({ item, owner, onClose }: { item: BrowserFeedback; owner: string | null; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const gesture = useRef<{ start: Pt; pts: number[] } | null>(null);
  const [elements, setElements] = useState<El[]>([]);
  const [draft, setDraft] = useState<El | null>(null);
  const [tool, setTool] = useState<Tool>('stroke');
  const [note, setNote] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.src = item.src;
    img.decode().then(() => {
      if (!live) return;
      image.current = img;
      const c = canvas.current!;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      setReady(true);
    }, () => live && setStatus('Could not load this capture. Capture it again.'));
    return () => { live = false; image.current = null; };
  }, [item.src]);
  useEffect(() => {
    const c = canvas.current, img = image.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    for (const el of elements) drawEl(ctx, el, palette);
    if (draft) drawEl(ctx, draft, palette);
  }, [ready, elements, draft]);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget, r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height };
  };
  const shape = (p: Pt): El => {
    const g = gesture.current!, a = g.start;
    const x = Math.min(a.x, p.x), y = Math.min(a.y, p.y), w = Math.abs(a.x - p.x), h = Math.abs(a.y - p.y);
    const base = { id: crypto.randomUUID(), z: elements.length, bbox: { x0: x, y0: y, x1: x + w, y1: y + h }, color: '#e23d35', size: Math.max(3, canvas.current!.width / 400) };
    if (tool === 'stroke') return { ...base, kind: 'stroke', pts: [...g.pts, p.x, p.y] };
    if (tool === 'arrow') return { ...base, kind: 'arrow', x1: a.x, y1: a.y, x2: p.x, y2: p.y };
    if (tool === 'text') return { ...base, kind: 'text', x: a.x, y: a.y, w: 300, h: 40, fontSize: Math.max(20, canvas.current!.width / 50), text: note };
    return { ...base, kind: tool, x, y, w, h, r: 0, rot: 0 };
  };
  const attach = async () => {
    setBusy(true);
    setStatus('');
    try {
      const blob = await new Promise<Blob>((ok, no) => canvas.current!.toBlob((b) => b ? ok(b) : no(new Error('Could not encode screenshot')), 'image/png'));
      const error = await attachFeedback(owner, [new File([blob], `${item.name}.png`, { type: 'image/png' }), new File([item.text], `${item.name}.txt`, { type: 'text/plain' })]);
      setStatus(error ?? 'Added to composer. Send your message when ready.');
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Could not attach screenshot'); }
    finally { setBusy(false); }
  };
  return <div className="brw-feedback" role="dialog" aria-label="Annotate screenshot" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
    <div className="brw-feedback-tools">
      <b>{item.name}</b>
      <button type="button" onClick={onClose}>Close</button>
    </div>
    <div className="brw-feedback-tools" aria-label="Drawing tools">
      {(['stroke', 'arrow', 'rect', 'ellipse', 'text'] as const).map((t) => <button type="button" key={t} aria-pressed={tool === t} onClick={() => setTool(t)}>{({ stroke: 'Draw', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text' })[t]}</button>)}
      <button type="button" disabled={!elements.length} onClick={() => setElements((v) => v.slice(0, -1))}>Undo</button>
      <button type="button" disabled={!elements.length} onClick={() => setElements([])}>Clear</button>
    </div>
    {tool === 'text' && <label>Text note <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Write a note, then click the image" /></label>}
    <div className="brw-feedback-image"><canvas ref={canvas} aria-label="Drawing canvas" onPointerDown={(e) => {
      if (!ready || busy || elements.length >= 200 || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = point(e);
      gesture.current = { start: p, pts: [p.x, p.y] };
      setDraft(shape(p));
    }} onPointerMove={(e) => {
      if (!gesture.current) return;
      const p = point(e);
      if (gesture.current.pts.length < 20000) gesture.current.pts.push(p.x, p.y);
      setDraft(shape(p));
    }} onPointerUp={(e) => {
      if (!gesture.current) return;
      const el = shape(point(e));
      setElements((v) => [...v, el]);
      gesture.current = null;
      setDraft(null);
    }} onPointerCancel={() => { gesture.current = null; setDraft(null); }} /></div>
    <details><summary>Element details / timestamp</summary><pre>{item.text}</pre></details>
    <div className="brw-feedback-tools"><button type="button" disabled={!ready || busy || !!draft} onClick={attach}>{busy ? 'Attaching…' : 'Attach image + details'}</button><span role="status">{status}</span></div>
  </div>;
}

// Decode the saved video's timeline, not screencast arrival indexes; only 12 small previews are retained.
export function Frames({ video, onPick }: { video: BrowserVideo; onPick: (item: BrowserFeedback) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [frames, setFrames] = useState<{ src: string; time: number }[]>([]);
  const [status, setStatus] = useState('Loading frames…');
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    let live = true;
    let index = 0;
    const c = document.createElement('canvas');
    const next = () => { v.currentTime = Math.min(Math.max(0, v.duration - 0.05), (++index / 12) * v.duration); };
    v.onloadeddata = () => { if (index === 0) next(); };
    v.onseeked = () => {
      if (!live) return;
      c.width = 180; c.height = Math.max(1, Math.round(180 * v.videoHeight / v.videoWidth));
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      const frame = { src: c.toDataURL('image/jpeg', 0.7), time: v.currentTime };
      setFrames((f) => [...f, frame]);
      if (index < 12) next(); else setStatus('Choose a preview or seek to the exact moment below.');
    };
    v.onerror = () => setStatus('Could not load recording frames');
    v.src = video.src;
    return () => { live = false; v.onloadeddata = v.onseeked = v.onerror = null; v.removeAttribute('src'); v.load(); };
  }, [video.src]);
  const capture = () => {
    const v = ref.current!;
    if (v.readyState < 2 || v.seeking) return;
    v.pause();
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const stamp = `${v.currentTime.toFixed(3)}s`;
    onPick({ id: crypto.randomUUID(), src: c.toDataURL('image/png'), name: `Frame ${stamp}`, text: `Recording: ${video.title || 'Browser recording'}\nTimestamp: ${stamp} from the start of the saved video` });
  };
  return <div className="brw-frames">
    <div className="brw-frame-strip">{frames.map((f, i) => <button type="button" key={i} onClick={() => { setBusy(true); ref.current!.currentTime = f.time; }}><img src={f.src} alt={`Frame at ${f.time.toFixed(3)} seconds`} /><span>{f.time.toFixed(3)}s</span></button>)}</div>
    <video ref={ref} src={video.src} controls muted playsInline onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onSeeking={() => setBusy(true)} onSeeked={() => setBusy(false)} onError={() => setStatus('Could not decode this recording')} />
    <div className="brw-feedback-tools"><button type="button" disabled={busy} onClick={capture}>Annotate frame at {time.toFixed(3)}s</button><span role="status">{status}</span></div>
  </div>;
}
