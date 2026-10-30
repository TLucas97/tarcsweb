import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { BrowserFeedback, BrowserVideo } from '../../../server/protocol.ts';
import { drawEl } from '../board/render.ts';
import type { El, Pt } from '../board/types.ts';
import { Chev, PencilIcon, TrashIcon, XIcon, useEscape } from '../bits.tsx';
import { attachFeedback } from '../SendToChat.tsx';
import { openSession } from '../socket.ts';
import { useStore } from '../store.ts';

// A capture waiting in the panel's tray. marks: the user's drawings, kept between edits. at: a frame's time in its recording.
export type Capture = BrowserFeedback & { marks: El[]; at?: number };

type Tool = 'stroke' | 'arrow' | 'rect' | 'ellipse' | 'text';
const palette = { ink: '#e23d35', grid: '#fff', accent: '#e23d35' };
const MESSAGE_FILES = 10;

const glyph = (d: string) => () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ArrowIcon = glyph('M3 11 11 3M6 3h5v5');
const RectIcon = glyph('M2.5 3.5h9v7h-9z');
const EllipseIcon = glyph('M7 3.3c2.6 0 4.6 1.6 4.6 3.7S9.6 10.7 7 10.7 2.4 9.1 2.4 7 4.4 3.3 7 3.3z');
const TextIcon = glyph('M3 3.5h8M7 3.5v7.5M5.5 11h3');
const UndoIcon = glyph('M4.5 3 2 5.5 4.5 8M2 5.5h6.3a3 3 0 0 1 0 6H6');
const PlayIcon = glyph('M4.5 2.8v8.4L11 7z');
const PauseIcon = glyph('M5 3v8M9 3v8');
const CheckIcon = glyph('M3.2 7.3 5.8 9.8 10.8 4.2');
const TOOLS: [Tool, string, typeof PencilIcon][] = [
  ['stroke', 'Draw', PencilIcon], ['arrow', 'Arrow', ArrowIcon], ['rect', 'Rectangle', RectIcon], ['ellipse', 'Ellipse', EllipseIcon], ['text', 'Text note', TextIcon],
];

const load = async (src: string) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
};

function paint(ctx: CanvasRenderingContext2D, img: HTMLImageElement, marks: El[]) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(img, 0, 0);
  for (const el of marks) drawEl(ctx, el, palette);
}

// The capture with its marks drawn in, at the capture's own size.
async function flatten(c: Capture) {
  const img = await load(c.src);
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  paint(cv.getContext('2d')!, img, c.marks);
  return cv;
}

const png = (cv: HTMLCanvasElement) => new Promise<Blob>((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error('Could not encode an image'))), 'image/png'));
const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Capture';
const notesOf = (c: Capture) => c.marks.flatMap((m) => (m.kind === 'text' && m.text.trim() ? [JSON.stringify(m.text.trim())] : []));

// Frames in one image with their times under them: one attachment instead of one per frame.
async function contactSheet(frames: Capture[]) {
  const cells = await Promise.all(frames.map(flatten));
  const cols = Math.min(3, cells.length);
  const rows = Math.ceil(cells.length / cols);
  const w = cols < 3 ? 720 : 480;
  const h = Math.round((w * cells[0].height) / cells[0].width);
  const band = 30;
  const gap = 10;
  const cv = document.createElement('canvas');
  cv.width = cols * w + (cols + 1) * gap;
  cv.height = rows * (h + band) + (rows + 1) * gap;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1e1d1a';
  cells.forEach((cell, i) => {
    const x = gap + (i % cols) * (w + gap);
    const y = gap + Math.floor(i / cols) * (h + band + gap);
    const k = Math.min(w / cell.width, h / cell.height);
    ctx.drawImage(cell, x + (w - cell.width * k) / 2, y + (h - cell.height * k) / 2, cell.width * k, cell.height * k);
    ctx.fillText(`${i + 1} · ${frames[i].at!.toFixed(3)} s`, x + 4, y + h + band / 2);
  });
  return cv;
}

// One image per capture (frames may share one sheet) plus one text file saying what each image shows.
async function attachCaptures(owner: string, captures: Capture[], sheet: boolean) {
  const frames = captures.filter((c) => c.at !== undefined).sort((a, b) => a.at! - b.at!);
  const groups = sheet && frames.length > 1 ? [...captures.filter((c) => c.at === undefined).map((c) => [c]), frames] : captures.map((c) => [c]);
  if (groups.length + 1 > MESSAGE_FILES) {
    return `That makes ${groups.length + 1} files and a message takes ${MESSAGE_FILES}. Remove some captures${frames.length > 1 && !sheet ? ' or put the frames in one image' : ''}.`;
  }
  const files: File[] = [];
  const text = ['Visual feedback from the Browser panel. Red marks and notes on the images were drawn by the user.'];
  for (const g of groups) {
    const base = safe(g.length > 1 ? `Frames ${g[0].at!.toFixed(3)}s to ${g.at(-1)!.at!.toFixed(3)}s` : g[0].name);
    let name = `${base}.png`;
    for (let k = 2; files.some((f) => f.name === name); k++) name = `${base} (${k}).png`;
    files.push(new File([await png(g.length > 1 ? await contactSheet(g) : await flatten(g[0]))], name, { type: 'image/png' }));
    text.push('', `[${name}]`);
    if (g.length > 1) text.push(`${g.length} frames, numbered left to right then down:`, ...g.map((c, i) => `${i + 1}. ${c.text}`));
    else text.push(g[0].text);
    const notes = g.flatMap(notesOf);
    if (notes.length) text.push(`Notes written on it: ${notes.join('; ')}`);
  }
  files.push(new File([text.join('\n')], 'Browser feedback.txt', { type: 'text/plain' }));
  return attachFeedback(owner, files);
}

export default function Editor({ item, n, onChange, onClose, onRemove }: { item: Capture; n: number; onChange: (marks: El[]) => void; onClose: () => void; onRemove: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const gesture = useRef<{ start: Pt; pts: number[] } | null>(null);
  const elements = item.marks;
  const [draft, setDraft] = useState<El | null>(null);
  const [tool, setTool] = useState<Tool>('stroke');
  const [note, setNote] = useState('');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  // Esc closes the editor before anything under it and keeps the drawings, like Done.
  useEscape(true, onClose);
  useEffect(() => {
    const back = document.activeElement;
    box.current?.focus({ preventScroll: true });
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    let live = true;
    load(item.src).then((img) => {
      if (!live) return;
      image.current = img;
      const c = canvas.current!;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      setSize({ w: img.naturalWidth, h: img.naturalHeight });
    }, () => live && setError('Could not load this capture. Capture it again.'));
    return () => {
      live = false;
      image.current = null;
    };
  }, [item.src]);
  useEffect(() => {
    const c = canvas.current;
    if (c && image.current) paint(c.getContext('2d')!, image.current, draft ? [...elements, draft] : elements);
  }, [size, elements, draft]);

  // The image is fitted with object-fit: contain, so the letterbox comes out before scaling to canvas px.
  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    const k = Math.min(r.width / c.width, r.height / c.height);
    return { x: (e.clientX - r.left - (r.width - c.width * k) / 2) / k, y: (e.clientY - r.top - (r.height - c.height * k) / 2) / k };
  };
  const shape = (p: Pt): El => {
    const g = gesture.current!;
    const a = g.start;
    const w = canvas.current!.width;
    const x = Math.min(a.x, p.x), y = Math.min(a.y, p.y), bw = Math.abs(a.x - p.x), bh = Math.abs(a.y - p.y);
    const base = { id: crypto.randomUUID(), z: elements.length, bbox: { x0: x, y0: y, x1: x + bw, y1: y + bh }, color: '#e23d35', size: Math.max(3, w / 400) };
    if (tool === 'stroke') return { ...base, kind: 'stroke', pts: [...g.pts, p.x, p.y] };
    if (tool === 'arrow') return { ...base, kind: 'arrow', x1: a.x, y1: a.y, x2: p.x, y2: p.y };
    if (tool === 'text') return { ...base, kind: 'text', x: a.x, y: a.y, w: 300, h: 40, fontSize: Math.max(20, w / 50), text: note };
    return { ...base, kind: tool, x, y, w: bw, h: bh, r: 0, rot: 0 };
  };

  return (
    <div ref={box} className="brw-fbe" role="dialog" aria-label={`Annotate capture ${n}`} tabIndex={-1}>
      <div className="brw-play-bar">
        <b title={item.name}>{n}. {item.name}</b>
        <button type="button" className="brw-lib-btn" title="Remove this capture" onClick={onRemove}>Remove</button>
        <button type="button" className="set-btn" title="Back to the captures (esc)" onClick={onClose}>Done</button>
      </div>
      <div className="brw-fbe-tools" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map(([t, name, Icon]) => (
          <button type="button" key={t} className="brw-nav" aria-pressed={tool === t} aria-label={name} title={name} onClick={() => setTool(t)}><Icon /></button>
        ))}
        <i aria-hidden="true"></i>
        <button type="button" className="brw-nav" aria-label="Undo" title="Undo" disabled={!elements.length} onClick={() => onChange(elements.slice(0, -1))}><UndoIcon /></button>
        <button type="button" className="brw-nav" aria-label="Clear drawings" title="Clear drawings" disabled={!elements.length} onClick={() => onChange([])}><TrashIcon /></button>
      </div>
      {tool === 'text' && (
        <div className="brw-url brw-fbe-note">
          <input ref={noteRef} autoFocus value={note} maxLength={1000} aria-label="Note" placeholder="Type a note, then click where it goes" onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      <div className="brw-fbe-canvas">
        <canvas
          ref={canvas} aria-label="Drawing canvas" style={size ? { maxWidth: size.w * 3, maxHeight: size.h * 3 } : undefined}
          onPointerDown={(e) => {
            if (!size || e.button !== 0 || elements.length >= 200) return;
            if (tool === 'text' && !note.trim()) return void noteRef.current?.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = point(e);
            gesture.current = { start: p, pts: [p.x, p.y] };
            setDraft(shape(p));
          }}
          onPointerMove={(e) => {
            if (!gesture.current) return;
            const p = point(e);
            if (gesture.current.pts.length < 20000) gesture.current.pts.push(p.x, p.y);
            setDraft(shape(p));
          }}
          onPointerUp={(e) => {
            if (!gesture.current) return;
            const el = shape(point(e));
            onChange([...elements, el]);
            gesture.current = null;
            setDraft(null);
            if (tool === 'text') setNote('');
          }}
          onPointerCancel={() => {
            gesture.current = null;
            setDraft(null);
          }}
        />
        {error && <p role="alert">{error}</p>}
      </div>
      <button type="button" className="brw-fbe-more" aria-expanded={details} onClick={() => setDetails(!details)}><Chev />Details sent with it</button>
      {details && <pre className="brw-fbe-details">{item.text}</pre>}
    </div>
  );
}

type TrayProps = {
  captures: Capture[];
  owner: string | null;
  sheet: boolean;
  onSheet: (sheet: boolean) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onOwner: (id: string) => void;
  onAttached: () => void;
};

// Captures waiting for the composer of the session that owns them; switching sessions shows it and never moves them.
export function Tray({ captures, owner, sheet, onSheet, onEdit, onRemove, onClear, onOwner, onAttached }: TrayProps) {
  const current = useStore((s) => s.current);
  // Captures taken with no session open follow the one shown, as the head says.
  const target = owner ?? current;
  const targetName = useStore((s) => (target ? s.roster.find((r) => r.id === target)?.name ?? null : null));
  const currentName = useStore((s) => s.roster.find((r) => r.id === s.current)?.name ?? 'another session');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const frames = captures.filter((c) => c.at !== undefined).length;
  const gone = !!target && targetName === null;
  const away = !!current && target !== current;
  const why = !target ? 'Open a session to attach these' : gone ? 'Its session is closed' : away ? `Open ${targetName} to attach these` : '';

  const attach = async () => {
    setBusy(true);
    setError('');
    try {
      const failed = await attachCaptures(target!, captures, sheet);
      if (failed) setError(failed);
      else onAttached();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not attach the captures');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="brw-fbt" role="region" aria-label="Captures">
      <div className="brw-fbt-head">
        <b>{captures.length} {captures.length === 1 ? 'capture' : 'captures'}</b>
        <span title={targetName ?? undefined}>{!target ? 'no session open' : gone ? 'for a closed session' : `for ${targetName}`}</span>
        <button type="button" className="brw-lib-btn" title="Remove all captures" onClick={onClear}>Clear</button>
      </div>
      {(away || gone) && current && (
        <div className="brw-fbt-away" role="status">
          <span title={currentName}>{gone ? 'That session is closed.' : `You're viewing ${currentName}.`}</span>
          {!gone && target && <button type="button" className="brw-lib-btn" title={`Open ${targetName}`} onClick={() => openSession(target)}>Switch back</button>}
          <button type="button" className="brw-lib-btn" title={`Attach these to ${currentName} instead`} onClick={() => onOwner(current)}>Move here</button>
        </div>
      )}
      <div className="brw-fbt-row">
        <ol className="brw-fbt-list">
          {captures.map((c, i) => (
            <li key={c.id}>
              <button type="button" className={`brw-fbt-chip${c.marks.length ? ' marked' : ''}`} title={`${c.name} · draw on it`} aria-label={`${i + 1}. ${c.name}. Draw on it`} onClick={() => onEdit(c.id)}>
                <img src={c.src} alt="" decoding="async" />
                <i aria-hidden="true">{i + 1}</i>
              </button>
              <button type="button" className="brw-x" aria-label={`Remove ${i + 1}. ${c.name}`} title="Remove" onClick={() => onRemove(c.id)}><XIcon /></button>
            </li>
          ))}
        </ol>
        <button type="button" className="set-btn" disabled={busy || !!why} title={why || 'Add to your message with their details. Nothing is sent yet.'} onClick={attach}>
          {busy ? 'Attaching…' : 'Attach to message'}
        </button>
      </div>
      {(frames > 1 || error) && (
        <div className="brw-fbt-foot">
          {frames > 1 && (
            <label className="brw-fbt-sheet">
              <button type="button" role="switch" className="mcp-sw" aria-checked={sheet} onClick={() => onSheet(!sheet)}><i></i></button>
              Frames as one image
            </label>
          )}
          {error && <span role="alert">{error}</span>}
        </div>
      )}
    </div>
  );
}

type FramesProps = { video: BrowserVideo; picked: Capture[]; full: boolean; onAdd: (c: Capture) => void; onRemove: (id: string) => void };

// Previews decode the saved video's timeline, not screencast arrival indexes; only 12 small ones are kept.
export function Frames({ video, picked, full, onAdd, onRemove }: FramesProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [previews, setPreviews] = useState<{ src: string; time: number }[]>([]);
  const [status, setStatus] = useState('Loading frames…');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
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
      setPreviews((f) => [...f, frame]);
      if (index < 12) next(); else setStatus('');
    };
    v.onerror = () => setStatus('Could not load recording frames');
    v.src = video.src;
    return () => { live = false; v.onloadeddata = v.onseeked = v.onerror = null; v.removeAttribute('src'); v.load(); };
  }, [video.src]);
  // Metadata can load before the player mounts, and React then drops its loadedmetadata event.
  useEffect(() => {
    const v = ref.current;
    if (v && v.readyState >= 1) setDuration(v.duration);
  }, []);

  const idAt = (t: number) => `${video.path}@${t.toFixed(3)}`;
  const has = (t: number) => picked.some((c) => c.id === idAt(t));
  const toggle = async (t: number) => {
    if (has(t)) return onRemove(idAt(t));
    if (full) return setStatus('The tray is full. Attach or remove captures first.');
    const v = ref.current!;
    const ac = new AbortController();
    setBusy(true);
    v.pause();
    try {
      if (Math.abs(v.currentTime - t) > 1e-3 || v.seeking || v.readyState < 2) {
        v.currentTime = t;
        await new Promise((ok, no) => {
          v.addEventListener('seeked', ok, { signal: ac.signal });
          v.addEventListener('error', no, { signal: ac.signal });
        });
      }
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      const stamp = t.toFixed(3);
      onAdd({ id: idAt(t), src: c.toDataURL('image/png'), name: `Frame ${stamp}s`, marks: [], at: t,
        text: `Frame at ${stamp} s of the recording ${video.title ? `"${video.title}" ` : ''}(${video.path})` });
    } catch {
      setStatus('Could not read this frame');
    } finally {
      ac.abort();
      setBusy(false);
    }
  };
  const on = has(time);

  return (
    <div className="brw-frames">
      <div className="brw-frames-view">
        <video
          ref={ref} src={video.src} muted playsInline preload="auto"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setStatus('Could not decode this recording')}
        />
      </div>
      <div className="brw-frames-bar">
        <button type="button" className="brw-nav" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'} onClick={() => (playing ? ref.current!.pause() : void ref.current!.play())}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="hpl-bar">
          <i style={{ transform: `scaleX(${duration ? time / duration : 0})` }}></i>
          <input
            type="range" min={0} max={duration || 0} step="any" value={time} aria-label="Position" aria-valuetext={`${time.toFixed(3)} seconds`}
            onChange={(e) => {
              const v = ref.current!;
              v.pause();
              v.currentTime = Number(e.currentTarget.value);
              setTime(v.currentTime);
            }}
          />
        </div>
        <time>{time.toFixed(3)}s</time>
        <button type="button" className="brw-lib-btn" aria-pressed={on} disabled={busy} onClick={() => toggle(time)}>{on ? 'Remove frame' : 'Add frame'}</button>
      </div>
      <ol className="brw-frames-grid" aria-label="Frames">
        {previews.map((f) => {
          const sel = has(f.time);
          return (
            <li key={f.time}>
              <button
                type="button" className="brw-frame" aria-pressed={sel} aria-label={`Frame at ${f.time.toFixed(3)} seconds`} disabled={busy}
                title={sel ? 'Remove this frame from the captures' : 'Add this frame to the captures'} onClick={() => toggle(f.time)}
              >
                <img src={f.src} alt="" />
                <span>{f.time.toFixed(3)}s</span>
                {sel && <b aria-hidden="true"><CheckIcon /></b>}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="brw-frames-note" role="status">{status || 'Click frames to add them, or drag the bar to an exact moment.'}</p>
    </div>
  );
}
