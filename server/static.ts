import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

// Vite puts content-hashed files here, so they never change under the same name.
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Serves a built client (vite build output) with an SPA fallback; off unless a dir is given. */
export function staticServer(dir: string) {
  const root = resolve(dir);
  const index = join(root, 'index.html');

  async function send(req: IncomingMessage, res: ServerResponse, file: string, cache: string) {
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return false;
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      etag,
    };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end(), true;
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end(), true;
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    } catch {
      return false;
    }
    if (path.includes('\0')) return false;
    const full = resolve(root, '.' + path);
    if (full !== root && !full.startsWith(root + sep)) return false;
    if (full !== root && full !== index) {
      const cache = full.startsWith(join(root, 'assets') + sep) ? IMMUTABLE : 'no-cache';
      if (await send(req, res, full, cache)) return true;
      // A missing file stays a 404; only app routes fall back to the page.
      if (extname(path)) return false;
    }
    return send(req, res, index, 'no-cache');
  };
}
