import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { IMAGE_MIMES } from '../../server/protocol.ts';
import { readFiles, type Pending } from './attach.ts';

// The composer registers how it takes files; false means it has no room.
type Sink = (files: Pending[]) => boolean;
let sink: Sink | null = null;
export function setComposerSink(fn: Sink | null) {
  sink = fn;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_SIDE = 2000;

// SVGs and other image types the API does not take are drawn into a PNG.
async function rasterize(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 1200;
    const h = img.naturalHeight || 800;
    const k = Math.min(2, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('encode'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const fileName = (name: string, mime: string) => `${(name.split('/').pop() || 'Image').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 80)}.${EXT[mime]}`;

// Attaches the picture at src to the composer like a pasted image; returns an error to show, or null.
export async function sendImage(src: string, name: string): Promise<string | null> {
  if (!sink) return 'No composer open';
  let blob: Blob;
  try {
    const r = await fetch(src);
    if (!r.ok) throw new Error(String(r.status));
    blob = await r.blob();
  } catch {
    return "Couldn't load the image";
  }
  if (!IMAGE_MIMES.includes(blob.type)) {
    if (!blob.type.startsWith('image/')) return 'Not an image';
    try {
      blob = await rasterize(blob);
    } catch {
      return "Couldn't read the image";
    }
  }
  const { ok } = await readFiles([new File([blob], fileName(name, blob.type), { type: blob.type })]);
  if (!ok.length) return "Couldn't read the image";
  return sink(ok) ? null : 'The composer is full';
}

export const SendIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2.5v7.2M4.9 6.6 8 9.7l3.1-3.1M3 13.2h10" />
  </svg>
);

const ADDED_MS = 1200;
const ERROR_MS = 2600;

// One-click "Send to chat" for a picture; the label itself reports the result.
export function SendImageBtn({ src, name, className, onAdded }: {
  src: string | (() => Promise<string | null>);
  name: string;
  className?: string;
  onAdded?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'added' | { error: string }>('idle');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = (s: 'added' | { error: string }) => {
    setState(s);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), s === 'added' ? ADDED_MS : ERROR_MS);
  };
  const go = async (e: MouseEvent) => {
    e.stopPropagation();
    if (state === 'busy') return;
    setState('busy');
    const url = typeof src === 'string' ? src : await src();
    const error = url ? await sendImage(url, name) : "Couldn't load the image";
    settle(error ? { error } : 'added');
    if (!error) onAdded?.();
  };

  const error = typeof state === 'object' ? state.error : null;
  return (
    <button
      type="button" className={`stc-img${className ? ` ${className}` : ''}${error ? ' bad' : ''}`}
      data-state={error ? 'error' : state} aria-busy={state === 'busy'} title="Attach this image to your message"
      onClick={go}
    >
      {!error && <SendIcon />}
      <span aria-live="polite">{error ?? (state === 'added' ? 'Added' : 'Send to chat')}</span>
    </button>
  );
}
