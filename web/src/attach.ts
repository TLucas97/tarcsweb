import { IMAGE_MIMES, type Upload } from '../../server/protocol.ts';

// A file waiting in the composer; thumb is a small data URL for images.
export type Pending = { key: string; upload: Upload; thumb: string | null };

// Long side of a sent image; larger pictures are scaled down before upload, like the API would.
const IMAGE_SIDE = 2000;
const IMAGE_BYTES = 3_500_000;
// The bubble shows images up to 280x120 CSS px; thumbs are drawn for 2x screens.
const THUMB_BOX = { w: 560, h: 240 };
const TEXT_BYTES = 1_500_000;
const PDF_BYTES = 20_000_000;

const b64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

function draw(img: ImageBitmap, side: number, box?: { w: number; h: number }) {
  const k = box ? Math.min(1, box.w / img.width, box.h / img.height) : Math.min(1, side / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

async function image(f: File): Promise<Pending> {
  const img = await createImageBitmap(f);
  const thumb = draw(img, 0, THUMB_BOX).toDataURL('image/webp', 0.85);
  let mime = f.type;
  let data: string;
  // GIFs keep their frames; everything else is re-encoded only when too big.
  if (f.type !== 'image/gif' && (Math.max(img.width, img.height) > IMAGE_SIDE || f.size > IMAGE_BYTES)) {
    const url = draw(img, IMAGE_SIDE).toDataURL('image/webp', 0.9);
    mime = 'image/webp';
    data = url.slice(url.indexOf(',') + 1);
  } else data = b64(await f.arrayBuffer());
  img.close();
  return { key: crypto.randomUUID(), upload: { name: f.name || 'Pasted image', kind: 'image', mime, data }, thumb };
}

// Anything that decodes as UTF-8 without NUL bytes counts as text (code, logs, JSON, CSV...).
async function text(f: File): Promise<Pending | null> {
  if (f.size > TEXT_BYTES) return null;
  const buf = await f.arrayBuffer();
  if (new Uint8Array(buf.slice(0, 8192)).includes(0)) return null;
  try {
    const data = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { key: crypto.randomUUID(), upload: { name: f.name, kind: 'text', mime: f.type || 'text/plain', data }, thumb: null };
  } catch {
    return null;
  }
}

// Reads dropped, pasted or picked files; returns what can be sent and the names that cannot.
export async function readFiles(files: Iterable<File>): Promise<{ ok: Pending[]; skipped: string[] }> {
  const ok: Pending[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    try {
      if (IMAGE_MIMES.includes(f.type)) ok.push(await image(f));
      else if (f.type === 'application/pdf' && f.size <= PDF_BYTES)
        ok.push({ key: crypto.randomUUID(), upload: { name: f.name, kind: 'pdf', mime: f.type, data: b64(await f.arrayBuffer()) }, thumb: null });
      else {
        const t = await text(f);
        if (t) ok.push(t);
        else skipped.push(f.name || 'file');
      }
    } catch {
      skipped.push(f.name || 'file');
    }
  }
  return { ok, skipped };
}
