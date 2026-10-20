import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';
import { CACHE_DIR } from './config.ts';
import { imageSize, localUrl } from './files.ts';
import type { BrowserVideo } from './protocol.ts';

// Videos of the Browser panel's active tab, encoded by ffmpeg from the screencast frames.

export const REC_DIR = join(CACHE_DIR, 'browser', 'recordings');
const FPS = 15;
export const REC_MAX_MS = 15 * 60_000;
const REC_MAX_BYTES = 1 << 30;
// Chrome scales bigger frames down, so a HiDPI page never costs a 4K encode.
export const REC_SIZE = { w: 1920, h: 1920 };
// Retention: the newest KEEP recordings, none older than KEEP_MS.
const KEEP = 20;
const KEEP_MS = 7 * 86_400_000;
const FIRST_FRAME_MS = 10_000;
// ffmpeg's last write (and the faststart rewrite) may take a while on a long recording.
const FINISH_MS = 60_000;
const SIZE_POLL_MS = 5000;
// The agent cursor hides like the panel's (cursor.ts IDLE_MS); a click ring shows this long.
const CURSOR_IDLE_MS = 1500;
const RING_MS = 450;
const OFF = -10_000;
export const NO_FFMPEG = 'Recording needs ffmpeg. Install it (for example from your package manager) and try again.';

const posterOf = (path: string) => path.replace(/\.(mp4|webm)$/, '.jpg');
const isVideo = (name: string) => /\.(mp4|webm)$/.test(name);

// ---- Encoder: the system ffmpeg (H.264 MP4, or VP8 WebM without libx264), else Playwright's bundled one (VP8 WebM only).
// cursor: it has what the burned-in agent cursor needs (overlay, zmq, rawvideo).
type Encoder = { bin: string; ext: 'mp4' | 'webm'; cursor: boolean };

const runnable = (p: string) => access(p, constants.X_OK).then(() => true, () => false);
async function onPath(name: string) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && (await runnable(join(dir, name)))) return join(dir, name);
  return null;
}
const listing = (bin: string, what: string) =>
  new Promise<string>((ok) => execFile(bin, ['-hide_banner', what], { timeout: 10_000, maxBuffer: 8 << 20 }, (_e, out) => ok(String(out ?? ''))));
const lists = (out: string, name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(out);

async function playwrightFfmpeg() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const dirs = (await readdir(root).catch(() => [] as string[])).filter((d) => /^ffmpeg-\d+$/.test(d)).sort((a, b) => parseInt(b.slice(7)) - parseInt(a.slice(7)));
  const name = process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux';
  for (const d of dirs) if (await runnable(join(root, d, name))) return join(root, d, name);
  return null;
}

async function detect(): Promise<Encoder | null> {
  const sys = await onPath('ffmpeg');
  if (sys) {
    const [enc, filters, demux] = await Promise.all(['-encoders', '-filters', '-demuxers'].map((w) => listing(sys, w)));
    const cursor = lists(filters, 'overlay') && lists(filters, 'zmq') && lists(demux, 'rawvideo');
    if (lists(enc, 'libx264')) return { bin: sys, ext: 'mp4', cursor };
    if (lists(enc, 'libvpx')) return { bin: sys, ext: 'webm', cursor };
  }
  const pw = await playwrightFfmpeg();
  return pw && lists(await listing(pw, '-encoders'), 'libvpx') ? { bin: pw, ext: 'webm', cursor: false } : null;
}

// Found once; a missing ffmpeg is looked for again a minute later, so installing it needs no restart.
let found: { at: number; p: Promise<Encoder | null> } | null = null;
export function encoder() {
  if (!found || Date.now() - found.at > 60_000) {
    const p = detect().catch(() => null);
    found = { at: Date.now(), p };
    void p.then((e) => e && found?.p === p && (found.at = Infinity));
  }
  return found.p;
}

// ---- Retention and cleanup.
async function recordings() {
  const names = await readdir(REC_DIR).catch(() => [] as string[]);
  const files = await Promise.all(names.filter(isVideo).map(async (n) => ({ path: join(REC_DIR, n), at: (await stat(join(REC_DIR, n)).catch(() => null))?.mtimeMs ?? 0 })));
  return files.sort((a, b) => b.at - a.at);
}

export async function prune(skip = '') {
  const now = Date.now();
  const all = await recordings();
  await Promise.all(all.filter((f, i) => f.path !== skip && (i >= KEEP || now - f.at > KEEP_MS)).map((f) => deleteRecording(f.path)));
  // Posters whose video (or part being written) is gone.
  const names = await readdir(REC_DIR).catch(() => [] as string[]);
  const kept = new Set(names.map((n) => n.replace(/\.part$/, '')).filter(isVideo).map(posterOf));
  await Promise.all(names.filter((n) => n.endsWith('.jpg') && !kept.has(n)).map((n) => rm(join(REC_DIR, n), { force: true })));
}

// Parts left by a server that died mid-recording cannot be played (no index), so they go.
// A part written in the last few minutes may belong to another server's recording, so only stale ones go.
export async function sweepParts(live: (path: string) => boolean) {
  const names = await readdir(REC_DIR).catch(() => [] as string[]);
  const stale = Date.now() - 5 * 60_000;
  await Promise.all(names.filter((n) => n.endsWith('.part') && !live(join(REC_DIR, n))).map(async (n) => {
    const p = join(REC_DIR, n);
    const s = await stat(p).catch(() => null);
    if (s && s.mtimeMs < stale) await rm(p, { force: true });
  }));
}

export async function deleteRecording(path: string) {
  if (dirname(path) !== REC_DIR || !isVideo(path)) return false;
  await Promise.all([rm(path, { force: true }), rm(posterOf(path), { force: true })]);
  return true;
}

export function videoOf(s: Saved): BrowserVideo {
  return { path: s.path, src: localUrl(s.path), poster: s.poster ? localUrl(s.poster) : null, ms: s.ms, w: s.w, h: s.h, bytes: s.bytes, title: s.title };
}

// ---- Agent cursor sprites, drawn like the panel's (.brw-cursor): white arrow with a dark rim and a coral dot, and a
// coral ring for a press. Coordinates are the cursor element's CSS px, scaled by s; 4x4 samples per pixel.
type Sprite = { w: number; h: number; hx: number; hy: number; data: Buffer };
type Rgba = [number, number, number, number];
const CORAL: Rgba = [183, 132, 31, 1];
const RIM: Rgba = [30, 29, 26, 1];
const WHITE: Rgba = [255, 255, 255, 1];
const ARROW = [[0, 0], [0, 14.6], [3.7, 11.1], [6.2, 16.9], [8.8, 15.8], [6.3, 10.1], [11.5, 10.1]];

function inPoly(x: number, y: number, p: number[][]) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function edgeDist(x: number, y: number, p: number[][]) {
  let d = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [ax, ay] = p[j];
    const [bx, by] = p[i];
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
  }
  return d;
}

function sprite(s: number, box: { x0: number; y0: number; x1: number; y1: number }, paint: (x: number, y: number) => Rgba | null): Sprite {
  const w = Math.ceil((box.x1 - box.x0) * s);
  const h = Math.ceil((box.y1 - box.y0) * s);
  const data = Buffer.alloc(w * h * 4);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const c = paint(box.x0 + (px + (sx + 0.5) / 4) / s, box.y0 + (py + (sy + 0.5) / 4) / s);
          if (!c) continue;
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const o = (py * w + px) * 4;
      if (a) [data[o], data[o + 1], data[o + 2], data[o + 3]] = [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / 16) * 255)];
    }
  }
  return { w, h, hx: Math.round(-box.x0 * s), hy: Math.round(-box.y0 * s), data };
}

function arrowSprite(s: number) {
  return sprite(s, { x0: -1, y0: -1, x1: 21, y1: 22 }, (x, y) => {
    const dot = Math.hypot(x - 15.5, y - 16.5);
    if (dot <= 3.5) return CORAL;
    if (dot <= 5) return WHITE;
    if (edgeDist(x, y, ARROW) <= 0.6) return RIM;
    return inPoly(x, y, ARROW) ? WHITE : null;
  });
}
function ringSprite(s: number) {
  return sprite(s, { x0: -14, y0: -14, x1: 14, y1: 14 }, (x, y) => {
    const d = Math.hypot(x, y);
    return d > 14 ? null : d >= 12 ? CORAL : [CORAL[0], CORAL[1], CORAL[2], 0.16];
  });
}

// ---- ffmpeg's zmq filter answers on a ZMTP 3.0 REP socket. This minimal DEALER client sends overlay moves without
// waiting for each reply; replies are read and dropped. Anything that fails just leaves the cursor off.
const zframe = (flags: number, body: Buffer) => Buffer.concat([Buffer.from([flags, body.length]), body]);
const GREETING = (() => {
  const b = Buffer.alloc(64);
  b[0] = 0xff;
  b[9] = 0x7f;
  b[10] = 3;
  b.write('NULL', 12);
  return b;
})();
const READY = (() => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(6);
  return zframe(0x04, Buffer.concat([Buffer.from([5]), Buffer.from('READY'), Buffer.from([11]), Buffer.from('Socket-Type'), len, Buffer.from('DEALER')]));
})();
const EMPTY = zframe(0x01, Buffer.alloc(0));

class FilterLink {
  private sock: Socket | null = null;
  private ready = false;
  private closed = false;
  private buf: Buffer = Buffer.alloc(0);
  private greeted = false;
  private port: number;

  constructor(port: number) {
    this.port = port;
    // ffmpeg binds once its filter graph starts, after the first frame.
    this.dial(Date.now() + FIRST_FRAME_MS);
  }

  private dial(until: number) {
    if (this.closed) return;
    const s = connect(this.port, '127.0.0.1');
    this.sock = s;
    s.on('connect', () => s.write(Buffer.concat([GREETING, READY])));
    s.on('data', (d: Buffer) => this.read(d));
    s.on('error', () => {});
    s.on('close', () => {
      if (this.sock !== s) return;
      this.sock = null;
      this.ready = this.greeted = false;
      this.buf = Buffer.alloc(0);
      if (!this.closed && Date.now() < until) setTimeout(() => this.dial(until), 150);
    });
  }

  private read(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (!this.greeted) {
      if (this.buf.length < 64) return;
      this.buf = this.buf.subarray(64);
      this.greeted = true;
    }
    while (this.buf.length >= 2) {
      const flags = this.buf[0];
      const long = flags & 0x02;
      if (long && this.buf.length < 9) return;
      const head = long ? 9 : 2;
      const len = long ? Number(this.buf.readBigUInt64BE(1)) : this.buf[1];
      if (this.buf.length < head + len) return;
      const body = this.buf.subarray(head, head + len);
      this.buf = this.buf.subarray(head + len);
      if (flags & 0x04 && body.subarray(1, 1 + body[0]).toString() === 'READY') this.ready = true;
    }
  }

  send(cmds: string[]) {
    if (!this.ready || !this.sock || !cmds.length) return;
    this.sock.write(Buffer.concat(cmds.flatMap((c) => [EMPTY, zframe(0, Buffer.from(c))])));
  }

  close() {
    this.closed = true;
    this.sock?.destroy();
    this.sock = null;
  }
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? ok(a.port) : fail(new Error('no port'))));
    });
  });

// ---- One recording.
export type Saved = { path: string; poster: string | null; ms: number; w: number; h: number; bytes: number; title: string | null; why: EndWhy };
// Why it ended: asked to, a cap, or Chrome went away.
export type EndWhy = 'stopped' | 'limit' | 'size' | 'chrome';
type Frame = { jpeg: Buffer; w: number; h: number; css: number };
type Hooks = { stopping: () => void; ended: (r: Saved | Error) => void; spawned: (p: ChildProcess) => void };

const stampOf = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const slugOf = (t: string | null) => (t ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// Frames come only when the page changes, so a timer writes the newest one FPS times a second: the frame count, not
// the arrival times, carries the timing. ffmpeg starts on the first frame, which fixes the video size.
export class Recording {
  readonly since = Date.now();
  readonly title: string | null;
  private enc: Encoder;
  private hooks: Hooks;
  private ff: ChildProcess | null = null;
  private started = false;
  private err = '';
  private last: Frame | null = null;
  private t0 = 0;
  private written = 0;
  private out = { w: 0, h: 0 };
  private path = '';
  private poster: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private ending: Promise<Saved> | null = null;
  private link: FilterLink | null = null;
  private arrow: Sprite | null = null;
  private ring: Sprite | null = null;
  // Cursor commands wait for the next tick, so a burst of moves costs one command pair per frame.
  private move: { x: number; y: number } | null = null;
  private press: { x: number; y: number } | null = null;
  private hideAt = 0;
  private ringAt = 0;

  constructor(enc: Encoder, title: string | null, hooks: Hooks) {
    this.enc = enc;
    this.title = title;
    this.hooks = hooks;
    this.timers.push(setTimeout(() => !this.ff && this.end('stopped', new Error('The page sent no picture to record.')), FIRST_FRAME_MS));
  }

  get ms() {
    return Math.round((this.written / FPS) * 1000);
  }

  // The file being written, once known.
  get part() {
    return this.path && `${this.path}.part`;
  }

  // css: the frame's viewport width in CSS px, which maps cursor points to frame px.
  frame(jpeg: Buffer, css: number) {
    if (this.ending) return;
    const size = imageSize(jpeg);
    if (!size || !size.w || !size.h) return;
    this.last = { jpeg, w: size.w, h: size.h, css: css > 0 ? css : size.w };
    if (this.started) return;
    this.started = true;
    void this.begin().catch((e) => this.end('stopped', e instanceof Error ? e : new Error(String(e))));
  }

  cursor(kind: 'move' | 'down', x: number, y: number) {
    if (!this.link) return;
    this.move = { x, y };
    if (kind === 'down') this.press = { x, y };
  }

  hideCursor() {
    this.move = this.press = null;
    this.hideAt = this.ringAt = 1;
  }

  private async begin() {
    const f = this.last!;
    this.out = { w: Math.max(2, Math.min(REC_SIZE.w, f.w) & ~1), h: Math.max(2, Math.min(REC_SIZE.h, f.h) & ~1) };
    await mkdir(REC_DIR, { recursive: true });
    const stem = join(REC_DIR, `${stampOf(new Date(this.since))}${slugOf(this.title) ? `-${slugOf(this.title)}` : ''}`);
    let path = `${stem}.${this.enc.ext}`;
    for (let n = 2; await access(path).then(() => true, () => false); n++) path = `${stem}-${n}.${this.enc.ext}`;
    if (this.ending || this.ff) return;
    this.path = path;
    const port = this.enc.cursor ? await freePort().catch(() => 0) : 0;
    if (this.ending || this.ff) return;
    if (port) {
      // A bit larger than the panel's, so the pointer reads at video size.
      const s = 1.4 * Math.max(1, Math.min(4, (f.w / f.css) * Math.min(this.out.w / f.w, this.out.h / f.h)));
      [this.arrow, this.ring] = [arrowSprite(s), ringSprite(s)];
    }
    const { w, h } = this.out;
    // Chrome's JPEGs are full range; players expect the limited range of plain yuv420p.
    const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease:out_range=tv,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
    const args = ['-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0', '-fpsprobesize', '0', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0'];
    if (port && this.arrow && this.ring) {
      const raw = (sp: Sprite, fd: number) => ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${sp.w}x${sp.h}`, '-i', `pipe:${fd}`];
      args.push(...raw(this.ring, 3), ...raw(this.arrow, 4), '-filter_complex',
        `[0:v]${fit},zmq=b=tcp\\\\://127.0.0.1\\\\:${port}[b];[b][1:v]overlay@ring=x=${OFF}:y=${OFF}:eval=frame[r];[r][2:v]overlay@arrow=x=${OFF}:y=${OFF}:eval=frame,format=yuv420p[v]`,
        '-map', '[v]');
    } else args.push('-vf', `${fit},format=yuv420p`);
    args.push('-an', ...(this.enc.ext === 'mp4'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-threads', '4', '-movflags', '+faststart', '-f', 'mp4']
      : ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '10', '-b:v', '2M', '-qmin', '0', '-qmax', '50', '-threads', '2', '-f', 'webm']), '-y', `${path}.part`);
    const ff = spawn(this.enc.bin, args, { stdio: ['pipe', 'ignore', 'pipe', ...(port ? ['pipe' as const, 'pipe' as const] : [])] });
    this.ff = ff;
    this.hooks.spawned(ff);
    ff.stderr!.on('data', (d: Buffer) => (this.err = (this.err + d).slice(-2000)));
    ff.stdin!.on('error', () => {});
    ff.once('error', (e) => this.end('stopped', new Error(`ffmpeg failed to start: ${e.message}`)));
    ff.once('exit', (code, sig) => !this.ending && this.end('stopped', new Error(`ffmpeg stopped (${sig ?? `exit code ${code}`}). ${this.err.trim().split('\n').at(-1) ?? ''}`.trim())));
    if (port && this.arrow && this.ring) {
      for (const [fd, sp] of [[3, this.ring], [4, this.arrow]] as const) {
        const pipe = ff.stdio[fd] as Writable;
        pipe.on('error', () => {});
        pipe.end(sp.data);
      }
      this.link = new FilterLink(port);
    }
    this.poster = posterOf(path);
    void writeFile(this.poster, f.jpeg).catch(() => (this.poster = null));
    this.t0 = performance.now();
    this.timers.push(
      setInterval(() => this.pump(), 1000 / FPS),
      setInterval(() => void stat(`${path}.part`).then((s) => s.size > REC_MAX_BYTES && this.end('size'), () => {}), SIZE_POLL_MS),
      setTimeout(() => this.end('limit'), REC_MAX_MS),
    );
    this.pump();
  }

  // Writes the newest frame until the count matches the time since the first one; a full pipe waits for the next tick.
  private pump(all = false) {
    const stdin = this.ff?.stdin;
    if (!stdin || !this.last || stdin.destroyed) return;
    const due = Math.floor(((performance.now() - this.t0) * FPS) / 1000) + 1;
    while (this.written < due && (all || !stdin.writableNeedDrain)) {
      stdin.write(this.last.jpeg);
      this.written++;
    }
    if (!all) this.flushCursor();
  }

  private flushCursor() {
    const link = this.link;
    const f = this.last;
    if (!link || !f || !this.arrow || !this.ring) return;
    const now = performance.now();
    // Page CSS px to output px, through the frame's scale and the letterbox scale+pad adds.
    const k = Math.min(this.out.w / f.w, this.out.h / f.h);
    const at = (p: { x: number; y: number }) => ({ x: Math.floor((this.out.w - f.w * k) / 2) + (p.x * f.w * k) / f.css, y: Math.floor((this.out.h - f.h * k) / 2) + (p.y * f.w * k) / f.css });
    const cmds: string[] = [];
    const place = (name: string, sp: Sprite, p: { x: number; y: number } | null) => {
      const q = p && at(p);
      cmds.push(`overlay@${name} x ${q ? Math.round(q.x - sp.hx) : OFF}`, `overlay@${name} y ${q ? Math.round(q.y - sp.hy) : OFF}`);
    };
    if (this.press) {
      place('ring', this.ring, this.press);
      this.ringAt = now + RING_MS;
      this.press = null;
    } else if (this.ringAt && now >= this.ringAt) {
      place('ring', this.ring, null);
      this.ringAt = 0;
    }
    if (this.move) {
      place('arrow', this.arrow, this.move);
      this.hideAt = now + CURSOR_IDLE_MS;
      this.move = null;
    } else if (this.hideAt && now >= this.hideAt) {
      place('arrow', this.arrow, null);
      this.hideAt = 0;
    }
    link.send(cmds);
  }

  // Safe to call any number of times; every caller gets the same outcome.
  stop(why: EndWhy, error?: Error): Promise<Saved> {
    this.ending ??= this.finish(why, error);
    return this.ending;
  }

  // A stop nobody awaits; the outcome still reaches hooks.ended.
  private end(why: EndWhy, error?: Error) {
    this.stop(why, error).catch(() => {});
  }

  private async finish(why: EndWhy, error?: Error): Promise<Saved> {
    this.hooks.stopping();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.link?.close();
    this.link = null;
    const ff = this.ff;
    const part = `${this.path}.part`;
    try {
      if (!ff) throw error ?? new Error('Nothing was recorded.');
      if (error) throw error;
      this.pump(true);
      ff.stdin!.end();
      if (!(await exited(ff, FINISH_MS))) {
        ff.kill('SIGKILL');
        throw new Error('ffmpeg did not finish the video in time.');
      }
      if (ff.exitCode !== 0) throw new Error(`ffmpeg failed (${ff.signalCode ?? `exit code ${ff.exitCode}`}). ${this.err.trim().split('\n').at(-1) ?? ''}`.trim());
      await rename(part, this.path);
      const bytes = (await stat(this.path)).size;
      const saved: Saved = { path: this.path, poster: this.poster, ms: this.ms, w: this.out.w, h: this.out.h, bytes, title: this.title, why };
      void prune(this.path).catch(() => {});
      this.hooks.ended(saved);
      return saved;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (ff && ff.exitCode === null && ff.signalCode === null) ff.kill('SIGKILL');
      if (this.path) await Promise.all([rm(part, { force: true }), this.poster ? rm(this.poster, { force: true }) : null]).catch(() => {});
      this.hooks.ended(err);
      throw err;
    }
  }
}

const exited = (p: ChildProcess, ms: number) =>
  p.exitCode !== null || p.signalCode !== null ? Promise.resolve(true) : new Promise<boolean>((ok) => {
    const t = setTimeout(() => ok(false), ms);
    p.once('exit', () => {
      clearTimeout(t);
      ok(true);
    });
  });
