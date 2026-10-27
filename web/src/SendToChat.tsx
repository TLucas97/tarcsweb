import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { IMAGE_MIMES, type TextLink } from '../../server/protocol.ts';
import { readFiles, type Pending } from './attach.ts';

// The composer registers how it takes files; false means it has no room.
type Sink = (files: Pending[]) => boolean;
let sink: Sink | null = null;
export function setComposerSink(fn: Sink | null) {
  sink = fn;
}

type TextSink = (text: string, note?: string) => void;
let textSink: TextSink | null = null;
export function setTextSink(fn: TextSink | null) {
  textSink = fn;
}
type CommandSink = (name: string) => void;
let commandSink: CommandSink | null = null;
export function setCommandSink(fn: CommandSink | null) {
  commandSink = fn;
}
// Puts "/name " at the start of the prompt like a pick in the slash menu, without sending; false with no composer open.
export function putCommand(name: string) {
  if (!commandSink) return false;
  commandSink(name);
  return true;
}

// A whole unsent message back into the composer: text after the draft, files and pastes in the tray, links kept.
export type Draft = { text: string; files: Pending[]; pastes: string[]; links: TextLink[] };
type DraftSink = (d: Draft) => boolean;
let draftSink: DraftSink | null = null;
export function setDraftSink(fn: DraftSink | null) {
  draftSink = fn;
}
// False with no composer open or no room for the files.
export const restoreDraft = (d: Draft) => !!draftSink?.(d);

// Adds text to the composer tray as a text attachment, with an optional note typed into the box and linked to it;
// false with no composer open.
export function attachText(text: string, note?: string) {
  if (!textSink || !text.trim()) return false;
  textSink(text, note);
  return true;
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
const RETRY = "Couldn't add. Click to try again";

// The label itself reports the result: Added, or the error for a moment.
function SendBtn({ className, title, job, onAdded }: { className?: string; title: string; job: () => Promise<string | null>; onAdded?: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'added' | { error: string }>('idle');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const go = async (e: MouseEvent) => {
    e.stopPropagation();
    if (state === 'busy') return;
    setState('busy');
    const error = await job().catch(() => RETRY);
    setState(error ? { error } : 'added');
    clearTimeout(timer.current);
    // An unexpected failure stays up, so the label itself is the way to retry.
    if (error !== RETRY) timer.current = window.setTimeout(() => setState('idle'), error ? ERROR_MS : ADDED_MS);
    if (!error) onAdded?.();
  };

  const error = typeof state === 'object' ? state.error : null;
  return (
    <button
      type="button" className={`stc-img${className ? ` ${className}` : ''}${error ? ' bad' : state === 'added' ? ' done' : ''}`}
      data-state={error ? 'error' : state} aria-busy={state === 'busy'} title={title}
      onClick={go}
    >
      {!error && <SendIcon />}
      <span aria-live="polite">{error ?? (state === 'added' ? 'Added' : 'Send to chat')}</span>
    </button>
  );
}

// One-click "Send to chat" for a picture.
export function SendImageBtn({ src, name, className, onAdded }: {
  src: string | (() => Promise<string | null>);
  name: string;
  className?: string;
  onAdded?: () => void;
}) {
  const job = async () => {
    const url = typeof src === 'string' ? src : await src();
    return url ? await sendImage(url, name) : "Couldn't load the image";
  };
  return <SendBtn className={className} title="Attach this image to your message" job={job} onAdded={onAdded} />;
}

// One-click "Send to chat" for text: read on click, so a card never builds it per render; lands in the tray as a text attachment.
export function SendTextBtn({ text, what, className = 'btnx stc-txt' }: {
  text: string | (() => string | null | Promise<string | null>);
  // Names the content in the tooltip: "Attach the code to your message".
  what: string;
  className?: string;
}) {
  const job = async () => {
    const s = typeof text === 'string' ? text : await text();
    if (!s?.trim()) return 'Nothing to send';
    return attachText(s) ? null : 'No composer open';
  };
  return <SendBtn className={className} title={`Attach ${what} to your message`} job={job} />;
}

// A fence longer than any backtick run in the body, so code holding ``` stays one block.
export function fenced(body: string, lang = '') {
  const run = Math.max(2, ...[...body.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const f = '`'.repeat(run + 1);
  return `${f}${lang}\n${body.replace(/\n+$/, '')}\n${f}`;
}

// A GFM table; pipes and newlines in cells would break its rows.
export function mdTable(columns: string[], rows: string[][], align: string[] = []) {
  const cell = (c: string) => c.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
  const rule = columns.map((_, i) => (align[i] === 'right' ? '---:' : align[i] === 'center' ? ':---:' : '---'));
  return [columns, rule, ...rows.map((r) => columns.map((_, i) => r[i] ?? ''))].map((r, k) => `| ${(k === 1 ? r : r.map(cell)).join(' | ')} |`).join('\n');
}
