// Shiki on demand, in a worker that starts when the first finished code block needs colors.
import type { HighlightReply, HighlightRequest } from './highlight.worker.ts';

export type Token = { content: string; color?: string };

const LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'json', 'shellscript', 'css', 'html', 'python', 'rust', 'go', 'yaml', 'toml', 'sql', 'diff', 'markdown', 'docker']);
const ALIAS: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsonc: 'json', json5: 'json',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', console: 'shellscript', py: 'python', rs: 'rust',
  yml: 'yaml', md: 'markdown', dockerfile: 'docker', patch: 'diff',
};

export const langOf = (raw: string) => {
  const l = raw.toLowerCase();
  return LANGS.has(l) ? l : ALIAS[l] ?? null;
};

// Bounded by entries and by the total code length it holds.
const cache = new Map<string, { lines: Token[][]; size: number }>();
const CACHE_MAX = 300;
const CACHE_CHARS = 2_000_000;
let cacheChars = 0;

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, (lines: Token[][] | null) => void>();
// The worker holds Shiki (~7 MB); a minute without work ends it and the next block starts a fresh one.
const WORKER_IDLE_MS = 60_000;
let workerTimer = 0;

function tokenize(code: string, lang: string) {
  clearTimeout(workerTimer);
  if (!worker) {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<HighlightReply>) => {
      waiting.get(e.data.id)?.(e.data.lines);
      waiting.delete(e.data.id);
      if (waiting.size) return;
      workerTimer = window.setTimeout(() => {
        worker?.terminate();
        worker = null;
      }, WORKER_IDLE_MS);
    };
    // A worker that fails to load leaves every block plain.
    worker.onerror = () => {
      for (const done of waiting.values()) done(null);
      waiting.clear();
    };
  }
  const id = ++nextId;
  return new Promise<Token[][] | null>((done) => {
    waiting.set(id, done);
    worker!.postMessage({ id, code, lang } satisfies HighlightRequest);
  });
}

const idle = () => new Promise<void>((res) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => res(), { timeout: 2000 }) : setTimeout(res, 16)));

// cyrb53: a 53-bit string hash, so keys stay short however long the code is.
function hash(s: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const keyOf = (code: string, lang: string) => `${lang}:${code.length}:${hash(code)}`;

// Cached tokens for a block highlighted before, so a remount paints colors on the first frame.
export const cached = (code: string, lang: string) => cache.get(keyOf(code, lang))?.lines ?? null;

// Waits for idle time so the swap to colored spans never lands inside a session opening.
export async function highlight(code: string, lang: string): Promise<Token[][] | null> {
  const key = keyOf(code, lang);
  const hit = cache.get(key);
  if (hit) return hit.lines;
  await idle();
  const lines = await tokenize(code, lang);
  if (!lines) return null;
  // A block bigger than a quarter of the budget is not cached, or it would evict everything else and stay over the cap.
  if (!cache.has(key) && code.length <= CACHE_CHARS / 4) {
    cache.set(key, { lines, size: code.length });
    cacheChars += code.length;
  }
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_MAX && cacheChars <= CACHE_CHARS) break;
    if (k === key) continue;
    cache.delete(k);
    cacheChars -= v.size;
  }
  return lines;
}
