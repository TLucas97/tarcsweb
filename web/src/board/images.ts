// Decoded pictures by key, with the load number that made each. Elements carry only the key, so moves,
// undo entries and copies share one bitmap.
const bitmaps = new Map<string, { bmp: ImageBitmap; n: number }>();
// The downscaled picture as a file, for the saved copy: the original when it needed no scaling, else encoded on first use.
const sources = new Map<string, Blob | Promise<Blob | null>>();
// Keys must not repeat across reloads or tabs, since saved pictures are stored by key.
const PAGE = Math.random().toString(36).slice(2, 8);
let seq = 0;
const decodedFns = new Set<() => void>();

// Longest side kept, matching the region PNG cap; bigger pictures are decoded straight to that size.
export const IMAGE_PX_MAX = 2000;
const FILE_BYTES_MAX = 40 << 20;
// Source pixels a picture may have: its size is read from the header first, so a small but huge-dimension file never decodes.
const SOURCE_PX_MAX = 50_000_000;
// Decoded bytes all pictures on the board, its undo history and the clipboard may hold together.
const BITMAP_BYTES_MAX = 256 << 20;
// Loads waiting their turn; decodes run one at a time.
const QUEUE_MAX = 3;

let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;

export const bitmapOf = (src: string) => bitmaps.get(src)?.bmp;

const bytes = (b: ImageBitmap) => b.width * b.height * 4;

// Closes bitmaps nothing refers to. Ones made after `since` are kept: the caller's `keep` was taken before they existed.
function prune(keep: ReadonlySet<string>, since: number) {
  for (const [src, e] of bitmaps) {
    if (keep.has(src) || e.n > since) continue;
    e.bmp.close();
    bitmaps.delete(src);
    sources.delete(src);
  }
}

// Width and height from the file's header, without decoding its pixels.
function measure(file: Blob) {
  const url = URL.createObjectURL(file);
  const im = new Image();
  return new Promise<{ w: number; h: number }>((done, fail) => {
    im.onload = () => done({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => fail(new Error('Could not read that image'));
    im.src = url;
  }).finally(() => {
    im.onload = im.onerror = null;
    im.src = '';
    URL.revokeObjectURL(url);
  });
}

async function decode(file: Blob, keep: ReadonlySet<string> | (() => ReadonlySet<string>), since: number) {
  if (file.size > FILE_BYTES_MAX) throw new Error('That image is too large (40 MB at most)');
  const { w, h } = await measure(file);
  if (!w || !h) throw new Error('Could not read that image');
  if (w * h > SOURCE_PX_MAX) throw new Error('That image has too many pixels (50 megapixels at most)');
  const k = Math.min(1, IMAGE_PX_MAX / Math.max(w, h));
  const rw = Math.max(1, Math.round(w * k)), rh = Math.max(1, Math.round(h * k));
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(file, k < 1 ? { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' } : {});
  } catch {
    throw new Error('Could not read that image');
  }
  try {
    prune(typeof keep === 'function' ? keep() : keep, since);
    let total = bytes(bmp);
    for (const e of bitmaps.values()) total += bytes(e.bmp);
    if (total > BITMAP_BYTES_MAX) throw new Error('The board holds too many images; delete some first');
    const n = ++seq, src = `img${PAGE}-${n}`;
    bitmaps.set(src, { bmp, n });
    if (k >= 1) sources.set(src, file);
    bmp = null;
    return { src, w: rw, h: rh };
  } finally {
    bmp?.close();
  }
}

// Decodes an image file, scaled down to IMAGE_PX_MAX. `keep` lists the keys still in use (a function is read right
// before pruning); loads run one after another, so an overlapping paste never closes the one before it.
export function loadImage(file: Blob, keep: ReadonlySet<string> | (() => ReadonlySet<string>)): Promise<{ src: string; w: number; h: number }> {
  if (waiting >= QUEUE_MAX) return Promise.reject(new Error('Still loading the last images'));
  const since = seq;
  waiting++;
  const run = queue.then(() => decode(file, keep, since)).finally(() => void waiting--);
  queue = run.catch(() => {});
  return run;
}

// The picture behind `src` as a file, or null once its bitmap is gone.
export function sourceOf(src: string): Promise<Blob | null> {
  const known = sources.get(src);
  if (known) return Promise.resolve(known);
  const bmp = bitmaps.get(src)?.bmp;
  if (!bmp) return Promise.resolve(null);
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  cv.getContext('2d')!.drawImage(bmp, 0, 0);
  const p: Promise<Blob | null> = cv.convertToBlob({ type: 'image/png' }).catch(() => null).then((b) => {
    if (sources.get(src) === p) {
      if (b) sources.set(src, b);
      else sources.delete(src);
    }
    return b;
  });
  sources.set(src, p);
  return p;
}

// A saved picture back under its old key; false when it cannot be decoded.
export async function restoreImage(src: string, blob: Blob): Promise<boolean> {
  if (bitmaps.has(src)) return true;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return false;
  }
  if (bitmaps.has(src)) return bmp.close(), true;
  bitmaps.set(src, { bmp, n: ++seq });
  sources.set(src, blob);
  for (const fn of decodedFns) fn();
  return true;
}

// Runs after a restored picture decodes, so an open board can repaint it.
export function onDecoded(fn: () => void) {
  decodedFns.add(fn);
  return () => void decodedFns.delete(fn);
}

// The first image file in a paste or drop.
export function imageFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const f of data.files) if (f.type.startsWith('image/')) return f;
  for (const it of data.items) if (it.kind === 'file' && it.type.startsWith('image/')) return it.getAsFile();
  return null;
}
