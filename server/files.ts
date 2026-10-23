import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { THUMB_SIDE, type AskedFile, type ReplayInfo, type ReplayPage, type Upload } from './protocol.ts';
import { CACHE_DIR } from './config.ts';

const MANIFEST_MAX = 1 << 20;
const FILE_MAX = 32 << 20;
const PAGES_MAX = 60;
const CANVAS = { width: 880, height: 800 };

// A folder a tool call in a live session pointed at; served read-only under an unguessable token.
type Grant = { dir: string; owner: string };
const grants = new Map<string, Grant>();

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
};

// Media, stylesheets, scripts and iframe pages a render_ui or replay page may pull from disk by file:// URL.
// The replay mod's check mirrors this list to flag what the viewer cannot load.
export const MEDIA = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.mp4', '.webm', '.woff', '.woff2', '.ttf', '.css', '.js', '.mjs', '.html', '.htm']);
// Served text whose own file:// links are rewritten too, so a shared CSS or JS file can name fonts and images.
const REWRITTEN = new Set(['.html', '.htm', '.css', '.js', '.mjs']);
const FONTS = new Set(['.woff', '.woff2', '.ttf']);
// Local videos (the Browser panel's recordings) may pass FILE_MAX; they stream in ranges.
const VIDEO = new Set(['.mp4', '.webm']);
const VIDEO_MAX = 2 * 2 ** 30;

// One "bytes=a-b" range: null for none or one this server ignores (several), false when it lies past the end.
function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return start <= end && start < size ? { start, end } : false;
}
const SECRET = randomBytes(32);
const sign = (path: string) => createHmac('sha256', SECRET).update(path).digest('base64url').slice(0, 32);

// The browser cannot open file:// from a sandboxed frame, so local media in model HTML goes through /files, signed per path.
export function localUrls(html: string) {
  return html.replace(/file:\/\/(\/[^"'`()<>\n]+)/g, (m, raw: string) => {
    const enc = raw.trimEnd();
    let path: string;
    try {
      path = decodeURI(enc);
    } catch {
      return m;
    }
    if (!MEDIA.has(extname(path).toLowerCase()) || path.includes('\0')) return m;
    return `${localUrl(path)}${raw.slice(enc.length)}`;
  });
}

export const localUrl = (path: string) => `/files/local/${sign(path)}${path.split('/').map(encodeURIComponent).join('/')}`;

// A signed URL for a local image whose size is already known, so no file read is needed.
export const localImageUrl = (path: string, w: number, h: number) => (w > 0 && h > 0 ? `${localUrl(path)}#wh=${w}x${h}` : localUrl(path));

const IMG_DIR = resolve(CACHE_DIR, 'img');
const IMG_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

// Image cache files this process wrote or saw, newest last; the write itself never blocks the caller.
const cached = new Map<string, Promise<void>>();
const CACHED_MAX = 2000;
let imgDir: Promise<unknown> | null = null;

function cacheImage(path: string, b64: string) {
  if (cached.has(path)) return;
  if (cached.size >= CACHED_MAX) cached.delete(cached.keys().next().value!);
  imgDir ??= mkdir(IMG_DIR, { recursive: true });
  const done = imgDir
    .then(() => writeFile(path, Buffer.from(b64, 'base64'), { flag: 'wx' }))
    .catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'EEXIST') cached.delete(path);
    });
  cached.set(path, done);
}

// Sent images go to a content-addressed cache so the bubble can open them full size; null when the type is unknown.
export function imageUrl(mime: string | undefined, b64: string): string | null {
  const ext = mime && IMG_EXT[mime];
  if (!ext) return null;
  const path = `${IMG_DIR}/${createHash('sha1').update(b64).digest('hex')}${ext}`;
  cacheImage(path, b64);
  return sized(localUrl(path), Buffer.from(b64.slice(0, HEAD_MAX * 4 / 3), 'base64'));
}

// Every cached image can be rebuilt: transcripts keep the base64 and history rewrites the file on load.
// Signed URLs die with the process, so only files this process handed out (cached) must stay.
const IMG_BYTES = 300 << 20;
// Other servers on this cache (dev, test ports) may have handed out recent files, so those always stay.
const IMG_KEEP_MS = 24 * 3600_000;

// Least recently used first (atime, else mtime) until the folder fits its byte cap.
export async function pruneImages() {
  try {
    const names = await readdir(IMG_DIR);
    const files = (await Promise.all(names.map((n) => {
      const path = `${IMG_DIR}/${n}`;
      return stat(path).then((s) => (s.isFile() ? { path, t: Math.max(s.atimeMs, s.mtimeMs), b: s.size } : null), () => null);
    }))).filter((f) => f !== null).sort((a, b) => a.t - b.t);
    let bytes = files.reduce((s, f) => s + f.b, 0);
    const keepFrom = Date.now() - IMG_KEEP_MS;
    for (const f of files) {
      if (bytes <= IMG_BYTES || f.t >= keepFrom) break;
      if (cached.has(f.path)) continue;
      await rm(f.path, { force: true });
      // Written again by the next imageUrl for it.
      cached.delete(f.path);
      bytes -= f.b;
    }
  } catch {}
}

// A data: URL (a composer thumbnail) stored like any sent image.
export function dataUrlImage(url: string) {
  const m = /^data:(image\/[a-z+.-]+);base64,/.exec(url);
  return m ? imageUrl(m[1], url.slice(m[0].length)) : null;
}

// Enough of the file to find a JPEG's frame header past its metadata.
const HEAD_MAX = 192 << 10;

// Pixel size from the file header, so the page can reserve the image's box before it loads.
export function imageSize(b: Buffer): { w: number; h: number } | null {
  try {
    if (b[0] === 0x89 && b.toString('latin1', 12, 16) === 'IHDR') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const v = b.readUInt32LE(21);
        return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
      return null;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < b.length && b[i] === 0xff; ) {
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}

// The size rides in the fragment, which never reaches the server or changes the signature.
const sized = (url: string, head: Buffer) => {
  const s = imageSize(head);
  return s && s.w > 0 && s.h > 0 ? `${url}#wh=${s.w}x${s.h}` : url;
};

export const inside = (dir: string, path: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

function grant(dir: string, owner: string) {
  for (const [token, g] of grants) if (g.dir === dir && g.owner === owner) return token;
  const token = randomUUID();
  grants.set(token, { dir, owner });
  return token;
}

export function revokeAll(owner: string) {
  for (const [token, g] of grants) if (g.owner === owner) grants.delete(token);
}

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
};

type ManifestPage = { id: string; title: string; full: string; raw: Record<string, unknown> };

// Parses a replay.json; a string is the error to show. Pages outside the manifest folder are skipped.
async function readManifest(manifest: string): Promise<{ title: string; dir: string; pages: ManifestPage[] } | string> {
  if (!isAbsolute(manifest) || extname(manifest).toLowerCase() !== '.json') return 'The manifest path is not an absolute .json file';
  let real: string;
  try {
    real = await realpath(manifest);
    const st = await stat(real);
    if (!st.isFile() || st.size > MANIFEST_MAX) return 'The manifest is missing or too large';
  } catch {
    return 'The manifest is gone';
  }
  let raw: { title?: unknown; pages?: unknown };
  try {
    raw = JSON.parse(await readFile(real, 'utf8'));
  } catch {
    return 'The manifest is not valid JSON';
  }
  if (!Array.isArray(raw.pages) || !raw.pages.length) return 'The manifest has no pages';
  const dir = dirname(real);
  const pages: ManifestPage[] = [];
  for (const [i, p] of (raw.pages as Record<string, unknown>[]).slice(0, PAGES_MAX).entries()) {
    if (typeof p?.file !== 'string') continue;
    const full = resolve(dir, p.file);
    if (!inside(dir, full)) continue;
    pages.push({ id: typeof p.id === 'string' && p.id ? p.id : `P${i + 1}`, title: typeof p.title === 'string' ? p.title.slice(0, 120) : `P${i + 1}`, full, raw: p });
  }
  const title = typeof raw.title === 'string' && raw.title ? raw.title.slice(0, 120) : 'Replay';
  return { title, dir, pages };
}

// Reads a replay.json the session's tool call named, and grants its folder (only) to the page iframes.
export async function loadReplay(manifest: string, owner: string): Promise<ReplayInfo> {
  const m = await readManifest(manifest);
  if (typeof m === 'string') return { title: 'Replay', pages: [], error: m };
  const token = grant(m.dir, owner);
  const pages: ReplayPage[] = m.pages.map(({ id, title, full, raw: p }) => {
    const fixed = p.width !== undefined || p.height !== undefined;
    return {
      id, title,
      url: `/files/${token}/${relative(m.dir, full).split(sep).map(encodeURIComponent).join('/')}`,
      width: fixed ? clamp(p.width, 320, 1300, CANVAS.width) : CANVAS.width,
      height: fixed ? clamp(p.height, 120, 1300, CANVAS.height) : CANVAS.height,
    };
  });
  return { title: m.title, pages, error: pages.length ? null : 'No page file is inside the manifest folder' };
}

export type ManifestRender = { id: string; title: string; full: string; width: number; height: number; fixed: boolean; durationMs: number };

// A replay.json's pages with their canvas, for the server-side render a Codex tab's replay tool reports on.
export async function manifestPages(manifest: string): Promise<{ title: string; pages: ManifestRender[] } | string> {
  const m = await readManifest(manifest);
  if (typeof m === 'string') return m;
  if (!m.pages.length) return 'No page file is inside the manifest folder';
  const pages = m.pages.map(({ id, title, full, raw: p }) => {
    const fixed = p.width !== undefined || p.height !== undefined;
    return {
      id, title, full, fixed,
      width: fixed ? clamp(p.width, 320, 1300, CANVAS.width) : CANVAS.width,
      height: fixed ? clamp(p.height, 120, 1300, CANVAS.height) : CANVAS.height,
      durationMs: clamp(p.duration_ms, 0, 20000, 0),
    };
  });
  return { title: m.title, pages };
}

// Input budget for the spoken replay summary; a page past this size is not read at all.
const SPOKEN_TEXT_MAX = 12_000;
const PAGE_HTML_MAX = 2 << 20;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', middot: '·' };

function pageText(html: string) {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|li|h[1-6]|tr|br|section|article|header|footer|pre|blockquote|figcaption|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim();
}

// The readable text of every replay page in order; the shortest pages keep all of theirs and the rest split what is left.
export async function readReplayText(manifest: string): Promise<{ title: string; pages: { title: string; text: string }[] } | null> {
  const m = await readManifest(manifest);
  if (typeof m === 'string') return null;
  const pages = await Promise.all(m.pages.map(async (p) => {
    try {
      const st = await stat(p.full);
      return { title: p.title, text: st.isFile() && st.size <= PAGE_HTML_MAX ? pageText(await readFile(p.full, 'utf8')) : '' };
    } catch {
      return { title: p.title, text: '' };
    }
  }));
  let left = SPOKEN_TEXT_MAX;
  const bySize = pages.map((_, i) => i).sort((a, b) => pages[a]!.text.length - pages[b]!.text.length);
  for (const [k, i] of bySize.entries()) {
    const p = pages[i]!;
    const share = Math.max(0, Math.floor(left / (bySize.length - k)));
    if (p.text.length > share) p.text = `${p.text.slice(0, share).replace(/\s+\S*$/, '')} …`;
    left -= p.text.length;
  }
  return { title: m.title, pages };
}

const RASTER = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const isImage = (h: Buffer) =>
  (h[0] === 0x89 && h.toString('latin1', 1, 4) === 'PNG') || (h[0] === 0xff && h[1] === 0xd8) || h.toString('latin1', 0, 3) === 'GIF' ||
  (h.toString('latin1', 0, 4) === 'RIFF' && h.toString('latin1', 8, 12) === 'WEBP');

// Only the page this server hosts (or Vite's proxy for it); EventSource GETs carry no Origin, only Sec-Fetch-Site.
// An opaque Origin ("null") fails the URL parse and is refused.
export function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'same-origin';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// POST /files/sign {path}: a signed URL for a local raster image the conversation mentions; same-origin pages only.
async function signImage(req: IncomingMessage, res: ServerResponse) {
  const reply = (code: number, body = '') => void res.writeHead(code, { 'content-type': 'application/json' }).end(body);
  if (req.method !== 'POST' || !sameOrigin(req)) return reply(403);
  let body = '';
  for await (const c of req) if ((body += c).length > 4096) return reply(413);
  let path: unknown;
  try {
    path = JSON.parse(body).path;
  } catch {
    return reply(400);
  }
  if (typeof path !== 'string') return reply(404);
  const head = await imageHead(path);
  if (typeof head === 'string') return reply(404);
  reply(200, JSON.stringify({ url: sized(localUrl(path), head) }));
}

// The first bytes of a local raster image, or why the path cannot show as one; the rules /files/sign applies.
async function imageHead(path: string): Promise<Buffer | string> {
  if (!isAbsolute(path) || /[\0\n\r]/.test(path)) return 'The path is not an absolute file path.';
  if (!RASTER.has(extname(path).toLowerCase())) return 'Only png, jpg, jpeg, gif and webp files can be shown.';
  try {
    const real = await realpath(path);
    if (!RASTER.has(extname(real).toLowerCase())) return 'The path links to a file that is not a png, jpg, gif or webp.';
    const st = await stat(real);
    if (!st.isFile()) return 'The path is not a file.';
    // The /files route refuses bigger files (413), so the picture would never load.
    if (st.size > FILE_MAX) return `The image is larger than ${FILE_MAX >> 20} MiB, the most that can be shown.`;
    const fh = await open(real, 'r');
    const buf = Buffer.alloc(HEAD_MAX);
    const { bytesRead } = await fh.read(buf, 0, HEAD_MAX, 0).finally(() => fh.close());
    const head = buf.subarray(0, bytesRead);
    return isImage(head) ? head : 'The file is not a valid png, jpg, gif or webp image.';
  } catch {
    return 'No such file.';
  }
}

// show_image: the picture's pixel size (0 when its header does not say), or why it cannot be shown.
export async function checkImage(path: string): Promise<{ w: number; h: number } | string> {
  const head = await imageHead(path);
  return typeof head === 'string' ? head : imageSize(head) ?? { w: 0, h: 0 };
}

// Files the user gave ask_upload, one folder per ask; the oldest asks go once the folder passes ASKED_BYTES.
const ASKED_DIR = resolve(CACHE_DIR, 'asked');
const ASKED_BYTES = 500 << 20;
const EXT_OF: Record<string, string> = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif' };

// A name safe on disk and in the tool's reply line; a picture the composer re-encoded gets its real extension.
function askedName(name: string, mime: string, taken: Set<string>) {
  let n = (name.split(/[\\/]/).pop() ?? '').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-120) || 'file';
  const ext = EXT_OF[mime];
  if (ext && !(ext === '.jpg' ? /\.jpe?g$/i.test(n) : n.toLowerCase().endsWith(ext))) n = n.replace(/\.[^.]*$/, '') + ext;
  let out = n;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = n.replace(/(\.[^.]*)?$/, (e) => `-${i}${e}`);
  taken.add(out.toLowerCase());
  return out;
}

export async function saveAsked(files: Upload[]): Promise<AskedFile[]> {
  const dir = resolve(ASKED_DIR, `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const taken = new Set<string>();
  const out: AskedFile[] = [];
  for (const f of files) {
    const path = resolve(dir, askedName(f.name, f.mime, taken));
    const data = f.kind === 'text' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data, 'base64');
    await writeFile(path, data, { flag: 'wx' });
    out.push({ path, name: f.name, bytes: data.length });
  }
  void pruneAsked(dir);
  return out;
}

async function pruneAsked(keep: string) {
  try {
    const dirs = (await Promise.all((await readdir(ASKED_DIR)).map(async (n) => {
      const dir = resolve(ASKED_DIR, n);
      const names = await readdir(dir).catch(() => [] as string[]);
      const sizes = await Promise.all(names.map((f) => stat(resolve(dir, f)).then((s) => s.size, () => 0)));
      return { dir, t: (await stat(dir).catch(() => null))?.mtimeMs ?? 0, b: sizes.reduce((a, b) => a + b, 0) };
    }))).sort((a, b) => a.t - b.t);
    let bytes = dirs.reduce((s, d) => s + d.b, 0);
    for (const d of dirs) {
      if (bytes <= ASKED_BYTES) break;
      if (d.dir === keep) continue;
      await rm(d.dir, { recursive: true, force: true });
      bytes -= d.b;
    }
  } catch {}
}

// Inline images load a small copy (?w=640) so the page decodes 640px pictures, not full-size screenshots.
const THUMB_DIR = resolve(CACHE_DIR, 'thumbs');
const THUMB_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const THUMBS_MAX = 2000;
const THUMBS_BYTES = 200 << 20;
const PRUNE_EVERY = 50;
// Optional (libvips); without it inline images load at full size.
const VIPS = (process.env.PATH ?? '').split(':').filter(Boolean).map((d) => resolve(d, 'vipsthumbnail')).find((p) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}) ?? null;
let vipsWarned = false;
const VIPS_MAX = 2;
const VIPS_MS = 20_000;
// Cache key -> thumbnail path, or null when the original is served (small, animated, or vips failed).
const thumbs = new Map<string, Promise<string | null>>();
const THUMB_KEYS_MAX = 2000;
let thumbDir: Promise<unknown> | null = null;
let thumbSeq = 0;
let made = 0;
let pruning = false;

// At most VIPS_MAX vips processes; a finished one hands its slot to the next waiter.
let vipsBusy = 0;
const vipsWait: (() => void)[] = [];
async function vips(args: string[]) {
  if (vipsBusy >= VIPS_MAX) await new Promise<void>((r) => vipsWait.push(r));
  else vipsBusy++;
  try {
    await new Promise<void>((ok, no) => execFile(VIPS!, args, { timeout: VIPS_MS }, (err) => (err ? no(err) : ok())));
  } finally {
    const next = vipsWait.shift();
    if (next) next();
    else vipsBusy--;
  }
}

// Oldest thumbnails go first once the folder passes its count or byte cap.
async function pruneThumbs() {
  if (pruning) return;
  pruning = true;
  try {
    const names = (await readdir(THUMB_DIR)).filter((n) => n.endsWith('.webp'));
    const files = (await Promise.all(names.map((n) => stat(`${THUMB_DIR}/${n}`).then((s) => ({ n, t: s.mtimeMs, b: s.size }), () => null))))
      .filter((f) => f !== null)
      .sort((a, b) => a.t - b.t);
    let count = files.length;
    let bytes = files.reduce((s, f) => s + f.b, 0);
    for (const f of files) {
      if (count <= THUMBS_MAX && bytes <= THUMBS_BYTES) break;
      await rm(`${THUMB_DIR}/${f.n}`, { force: true });
      count--;
      bytes -= f.b;
    }
  } catch {} finally {
    pruning = false;
  }
}

async function makeThumb(real: string, key: string, side: number): Promise<string | null> {
  const out = `${THUMB_DIR}/${key}.webp`;
  if (await stat(out).then(() => true, () => false)) return out;
  const tmp = `${THUMB_DIR}/${key}.${process.pid}-${++thumbSeq}.webp`;
  try {
    const fh = await open(real, 'r');
    const buf = Buffer.alloc(HEAD_MAX);
    const { bytesRead } = await fh.read(buf, 0, HEAD_MAX, 0).finally(() => fh.close());
    const head = buf.subarray(0, bytesRead);
    const size = imageSize(head);
    // GIFs and animated WebPs keep their frames.
    const animated = head.toString('latin1', 0, 3) === 'GIF' || (head.toString('latin1', 12, 16) === 'VP8X' && (head[20] & 0x02) !== 0);
    if (!isImage(head) || animated || !size || Math.max(size.w, size.h) <= side) return null;
    thumbDir ??= mkdir(THUMB_DIR, { recursive: true });
    await thumbDir;
    await vips([real, '--size', `${side}x${side}>`, '-o', `${tmp}[Q=82]`]);
    await rename(tmp, out);
    if (made++ % PRUNE_EVERY === 0) void pruneThumbs();
    return out;
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    return null;
  }
}

// The thumbnail for a file version (path, mtime, size), made once; null means serve the original.
async function thumbOf(real: string, mtime: number, bytes: number, side: number) {
  if (!VIPS) {
    if (!vipsWarned) console.log('vipsthumbnail not found on PATH: inline images load at full size');
    vipsWarned = true;
    return null;
  }
  const key = createHash('sha1').update(`${real}\0${mtime}\0${bytes}\0${side}`).digest('hex');
  let p = thumbs.get(key);
  if (!p) {
    p = makeThumb(real, key, side);
    thumbs.set(key, p);
    if (thumbs.size > THUMB_KEYS_MAX) thumbs.delete(thumbs.keys().next().value!);
  }
  const path = await p;
  if (!path) return null;
  const st = await stat(path).catch(() => null);
  // Pruned since: make it again on the next request.
  if (!st) thumbs.delete(key);
  return st && { path, size: st.size };
}

// GET /files/<token>/<path>: a read-only file from a granted folder; false when the URL is not ours.
export async function serveFile(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://local');
  if (!url.pathname.startsWith('/files/')) return false;
  if (url.pathname === '/files/sign') return await signImage(req, res), true;
  const end = (code: number) => void res.writeHead(code, { 'content-type': 'text/plain' }).end(String(code));
  if (req.method !== 'GET' && req.method !== 'HEAD') return end(405), true;
  const [token, ...rest] = url.pathname.slice('/files/'.length).split('/');
  let rel: string;
  try {
    rel = rest.map(decodeURIComponent).join('/');
  } catch {
    return end(400), true;
  }
  if (!rel || rel.includes('\0')) return end(404), true;
  // /files/local/<sig>/<abs path>: one media file a render_ui page named.
  const local = token === 'local' ? { sig: rest[0], path: '/' + rel.split('/').slice(1).join('/') } : null;
  const g = local ? null : grants.get(token);
  if (!local && !g) return end(404), true;
  if (local && (local.sig !== sign(local.path) || !MEDIA.has(extname(local.path).toLowerCase()))) return end(404), true;
  const full = local ? local.path : resolve(g!.dir, rel);
  if (g && !inside(g.dir, full)) return end(403), true;
  try {
    // A just-sent image may still be on its way to the cache.
    if (local) await cached.get(full);
    // Symlinks must not lead out of the folder either.
    const real = await realpath(full);
    if (g && !inside(g.dir, real)) return end(403), true;
    if (local && !MEDIA.has(extname(real).toLowerCase())) return end(403), true;
    const st = await stat(real);
    if (!st.isFile()) return end(404), true;
    const ext = extname(real).toLowerCase();
    if (st.size > (local && VIDEO.has(ext) ? VIDEO_MAX : FILE_MAX)) return end(413), true;
    const thumb = local && Number(url.searchParams.get('w')) === THUMB_SIDE && THUMB_EXT.has(ext)
      ? await thumbOf(real, st.mtimeMs, st.size, THUMB_SIDE)
      : null;
    // Replay pages name the shared stylesheet and images by file://, which a sandboxed frame cannot open.
    const body = REWRITTEN.has(ext) ? Buffer.from(localUrls(await readFile(real, 'utf8'))) : null;
    // A video seeks with Range requests; without them the player can only play from the start.
    const range = VIDEO.has(ext) ? byteRange(req.headers.range, st.size) : null;
    if (range === false) return void res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end(), true;
    res.writeHead(range ? 206 : 200, {
      'content-type': thumb ? 'image/webp' : TYPES[ext] ?? 'application/octet-stream',
      'content-length': body?.length ?? thumb?.size ?? (range ? range.end - range.start + 1 : st.size),
      ...(VIDEO.has(ext) ? { 'accept-ranges': 'bytes' } : {}),
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${st.size}` } : {}),
      // A sandboxed frame has an opaque origin, and fonts load only with CORS.
      ...(FONTS.has(ext) ? { 'access-control-allow-origin': '*' } : {}),
      // Sandboxed even when opened directly, and never sniffed into another type.
      'content-security-policy': 'sandbox allow-scripts',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end(), true;
    if (body) return res.end(body), true;
    createReadStream(thumb?.path ?? real, range ?? undefined).on('error', () => res.destroy()).pipe(res);
  } catch {
    end(404);
  }
  return true;
}
