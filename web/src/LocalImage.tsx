import { useEffect, useState } from 'react';
import { THUMB_SIDE } from '../../server/protocol.ts';
import { openImage } from './ImageViewer.tsx';
import { SendImageBtn } from './SendToChat.tsx';
import { useStore } from './store.ts';

// An absolute path to a raster image, optionally as file://.
export const IMAGE_PATH = /^(?:file:\/\/)?(\/.+\.(?:png|jpe?g|webp|gif))$/i;

export function localImagePath(s: string): string | null {
  const m = IMAGE_PATH.exec(s.trim());
  if (!m) return null;
  try {
    return s.trim().startsWith('file://') ? decodeURI(m[1]) : m[1];
  } catch {
    return null;
  }
}

// The server signs the path, and only for a real image file.
const signed = new Map<string, Promise<string | null>>();
// Settled signatures, so a remount (switching back to a session) renders the image in its first frame.
const signedNow = new Map<string, string | null>();
// Oldest signatures drop first; a dropped one is signed again on its next mount.
const SIGNED_MAX = 300;
// The signed URL, null for no such image, undefined when the request failed: that is no answer about the file.
async function signOnce(path: string): Promise<string | null | undefined> {
  try {
    const r = await fetch('/files/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    if (!r.ok) return r.status >= 500 ? undefined : null;
    return ((await r.json()) as { url?: string }).url ?? null;
  } catch {
    return undefined;
  }
}

export function sign(path: string) {
  let p = signed.get(path);
  if (!p) {
    const mine: Promise<string | null> = signOnce(path).then((u) => {
      const kept = signed.get(path) === mine;
      // A failed request is not kept, so the next mount asks again.
      if (u === undefined) {
        if (kept) signed.delete(path);
        return null;
      }
      if (kept) signedNow.set(path, u);
      return u;
    });
    p = mine;
    signed.set(path, p);
    while (signed.size > SIGNED_MAX) {
      const old = signed.keys().next().value!;
      signed.delete(old);
      signedNow.delete(old);
    }
  }
  return p;
}

// The pixel size the server put in an image URL's fragment, if any.
export function sizeOf(src: string | undefined) {
  const m = src ? /#wh=(\d+)x(\d+)$/.exec(src) : null;
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

// The server's small copy of a signed local image; GIFs, remote and data: URLs come back unchanged.
export function thumbUrl(src: string) {
  if (!src.startsWith('/files/local/') || /\.gif(?:#|$)/i.test(src)) return src;
  const i = src.indexOf('#');
  return i < 0 ? `${src}?w=${THUMB_SIDE}` : `${src.slice(0, i)}?w=${THUMB_SIDE}${src.slice(i)}`;
}

// Live Image objects keep shown pictures decoded, so switching sessions back does not decode them again.
const pool = new Map<string, HTMLImageElement>();
const POOL_MAX = 60;
export function keepImage(url: string) {
  if (!url.startsWith('/files/')) return;
  let img = pool.get(url);
  if (img) pool.delete(url);
  else {
    img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
  pool.set(url, img);
  while (pool.size > POOL_MAX) pool.delete(pool.keys().next().value!);
}

// A restarted server signs with a new key, so every URL signed by the old one is dead.
useStore.subscribe((s, prev) => {
  if (!prev.serverId || s.serverId === prev.serverId) return;
  signed.clear();
  signedNow.clear();
  pool.clear();
});

// Matches `.limg img` max-height in styles.css.
const MAX_H = 320;

// Reserves the thumbnail's box from the size the server put in the URL, so loading it moves nothing.
function Thumb({ src, alt, onError }: { src: string; alt: string; onError: () => void }) {
  const size = sizeOf(src);
  const small = thumbUrl(src);
  const [trust, setTrust] = useState(true);
  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const box = size && trust ? { width: Math.min(w, (MAX_H * w) / h), aspectRatio: `${w} / ${h}` } : undefined;
  // A rotated JPEG can disagree with its header (then the image sizes itself); a thumbnail may be off by a rounded pixel.
  const check = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const i = e.currentTarget;
    keepImage(small);
    const nw = i.naturalWidth;
    const nh = i.naturalHeight;
    if (box && Math.min(Math.abs(nw - (nh * w) / h), Math.abs(nh - (nw * h) / w)) > 1.5) setTrust(false);
  };
  return (
    <img
      src={small} alt={alt} style={box} className={box ? 'sized' : undefined} loading="lazy" decoding="async"
      onLoad={check} onError={onError} onClick={(e) => openImage(e, small === src ? undefined : src)}
    />
  );
}

// A thumbnail of a local image; it opens in the full-screen viewer.
export function LocalImage({ path, alt }: { path: string; alt?: string }) {
  const [src, setSrc] = useState<string | null | undefined>(() => signedNow.get(path));
  // The URL that failed to load once and was signed again; a second failure shows the missing line.
  const [resigned, setResigned] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void sign(path).then((u) => live && setSrc(u));
    return () => { live = false; };
  }, [path]);
  const reload = () => {
    if (!src || resigned) return setSrc(null);
    setResigned(src);
    signed.delete(path);
    signedNow.delete(path);
    void sign(path).then((u) => setSrc(u && u !== src ? u : null));
  };
  // While signing, hold the missing-file line's space: it is the usual outcome in old sessions.
  if (src === undefined) return <span className="limg miss" style={{ visibility: 'hidden' }}>{alt || path}</span>;
  if (src === null) return <span className="limg miss">{alt || path}</span>;
  const name = path.split('/').pop() || 'Image';
  return (
    <span className="limg stc-host">
      <Thumb src={src} alt={alt || name} onError={reload} />
      <SendImageBtn src={src} name={name} className="stc-float" />
    </span>
  );
}

// A thumbnail for a picture a tool returned; its URL is already signed, so a failed load cannot be signed again.
export function ToolImage({ src, alt }: { src: string; alt: string }) {
  const [bad, setBad] = useState(false);
  if (bad) return <span className="limg miss">{alt || 'Image'}</span>;
  return (
    <span className="limg stc-host">
      <Thumb src={src} alt={alt} onError={() => setBad(true)} />
      <SendImageBtn src={src} name={alt || 'Image'} className="stc-float" />
    </span>
  );
}
