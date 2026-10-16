import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { imageSize } from '../files.ts';
import { oneLine } from '../text.ts';
import { codexAccount } from './account.ts';
import { startThread, type CodexPolicy, type CodexThread } from './threads.ts';
import type { ThreadItem, Turn, UserInput } from './types.ts';

const TIMEOUT_MS = 6 * 60_000;
export const IMAGE_COUNT_MAX = 4;
const REFS_MAX = 10;
const NAMES_MAX = 1000;
// The image tool needs no approval, and a read-only sandbox keeps Codex off the user's files.
const POLICY: CodexPolicy = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
// An empty folder as the thread's cwd, so no project config or files come along.
const SCRATCH = resolve(CACHE_DIR, 'codex-image');

const DEV_NOTE = `You make raster images for another agent (Claude Code in the tarcsweb web UI) with your built-in image generation tool.
- Call the image generation tool once per requested image, with the brief as its prompt. Keep the brief's intent and add nothing unrelated.
- Attached images are references, numbered Image 1, Image 2 and so on in the order given.
- Do not run commands, edit files, or make the image any other way (no SVG, HTML, canvas or scripts). Do not copy or move the results; the host saves them.
- When done, reply with one short line.`;

export type ImageArgs = { prompt: string; filename?: string; output_dir?: string; reference_images?: string[]; count?: number };
export type SavedImage = { path: string; width: number | null; height: number | null; mime: string; data: Buffer };
export type ImageRun = { images: SavedImage[]; asked: number; revised: string[]; ms: number };
type ImageItem = Extract<ThreadItem, { type: 'imageGeneration' }>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);
const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

// The localized desktop folder, like the codex-image-generation skill; looked up once.
let desktop: Promise<string> | null = null;
function desktopDir() {
  desktop ??= (async () => {
    const xdg = await new Promise<string>((done) => execFile('xdg-user-dir', ['DESKTOP'], { timeout: 5000 }, (err, out) => done(err ? '' : String(out).trim())));
    for (const d of [xdg, join(homedir(), 'Desktop'), join(homedir(), 'Área de trabalho')]) if (d && d !== homedir() && (await isDir(d))) return d;
    return homedir();
  })();
  return desktop;
}

const FILLER = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'at', 'with', 'and', 'for', 'to', 'by', 'from', 'into', 'over', 'under']);
// "small-amber-square-dark-background-flat" from the prompt, or the caller's filename without its extension.
function stemOf(prompt: string, filename: string | undefined) {
  const own = filename ? basename(filename).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\0-\x1f/\\]+/g, ' ').trim() : '';
  if (own) return own.slice(0, 120);
  const words = prompt.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  return words.filter((w) => w && !FILLER.has(w)).slice(0, 6).join('-').slice(0, 60).replace(/-+$/, '') || 'codex-image';
}

function mimeOf(b: Buffer) {
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', ext: '.png' };
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', ext: '.jpg' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

// Codex saves the file itself (savedPath); result is the same picture as base64.
async function bytesOf(item: ImageItem): Promise<Buffer | null> {
  if (item.savedPath) {
    const b = await readFile(item.savedPath).catch(() => null);
    if (b?.length) return b;
  }
  const r = item.result?.trim();
  if (!r) return null;
  if (r.startsWith('/')) return readFile(r).catch(() => null);
  const b = Buffer.from(r.replace(/^data:[^,]*,/, ''), 'base64');
  return b.length ? b : null;
}

// Writes under the first free name (stem, stem-2, …); an existing file is never replaced.
async function place(dir: string, stem: string, ext: string, data: Buffer) {
  for (let i = 1; i <= NAMES_MAX; i++) {
    const path = join(dir, `${stem}${i > 1 ? `-${i}` : ''}${ext}`);
    try {
      await writeFile(path, data, { flag: 'wx' });
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`No free file name for ${stem}${ext} in ${dir}.`);
}

async function references(paths: string[], cwd: string) {
  if (paths.length > REFS_MAX) throw new Error(`At most ${REFS_MAX} reference images.`);
  const out: string[] = [];
  for (const p of paths) {
    const full = resolve(cwd, expandHome(p));
    const head = await readFile(full).then((b) => b.subarray(0, 16), () => null);
    if (!head) throw new Error(`Reference image not found: ${full}`);
    if (!mimeOf(head) && head.toString('latin1', 0, 3) !== 'GIF') throw new Error(`Reference is not a PNG, JPEG, WebP or GIF image: ${full}`);
    out.push(full);
  }
  return out;
}

const resetText = (at: number | null) => (at ? ` It resets ${new Date(at > 1e12 ? at : at * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.` : '');

type Outcome = { turn: Turn; items: ImageItem[]; said: string; error: string | null };

// Runs one turn and collects its image items; rejects on timeout, abort, or the thread going away.
function runTurn(thread: CodexThread, input: UserInput[], signal: AbortSignal | undefined) {
  return new Promise<Outcome>((done, fail) => {
    const items: ImageItem[] = [];
    let said = '';
    let error: string | null = null;
    const stop = (e: Error) => {
      end();
      fail(e);
    };
    const timer = setTimeout(() => stop(new Error(`Image generation took longer than ${TIMEOUT_MS / 60_000} minutes and was stopped.`)), TIMEOUT_MS);
    const onAbort = () => stop(new Error('Image generation was stopped.'));
    const unsub = thread.subscribe((e) => {
      if (e.type === 'item-completed' && e.item.type === 'imageGeneration') items.push(e.item);
      else if (e.type === 'item-completed' && e.item.type === 'agentMessage') said = e.item.text;
      else if (e.type === 'error' && !e.willRetry) error = e.error.message;
      else if (e.type === 'turn-completed') {
        end();
        done({ turn: e.turn, items, said, error });
      } else if (e.type === 'closed') stop(new Error(e.reason));
    });
    function end() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsub();
    }
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    thread.startTurn(input).catch((e: unknown) => stop(e instanceof Error ? e : new Error(String(e))));
  });
}

// One ephemeral Codex thread that calls its image tool; the pictures are copied out under new names.
export async function generateImages(args: ImageArgs, cwd: string, signal?: AbortSignal): Promise<ImageRun> {
  const prompt = args.prompt?.trim();
  if (!prompt) throw new Error('The prompt is empty.');
  const count = Math.min(IMAGE_COUNT_MAX, Math.max(1, Math.round(args.count ?? 1)));
  const refs = await references(args.reference_images ?? [], cwd);
  const dir = args.output_dir ? resolve(cwd, expandHome(args.output_dir)) : join(await desktopDir(), 'AI Images');
  const status = codexAccount.status?.signedIn ? codexAccount.status : await codexAccount.check();
  if (!status.installed) throw new Error('The codex CLI is not installed on this machine. Install it, then sign in from Settings > Account in tarcsweb.');
  if (!status.signedIn) throw new Error(`Codex is not signed in${status.error ? ` (${status.error})` : ''}. The user can sign in from Settings > Account in tarcsweb.`);
  await mkdir(dir, { recursive: true });
  await mkdir(SCRATCH, { recursive: true });

  const started = Date.now();
  const thread = await startThread({ cwd: SCRATCH, mode: 'default', policy: POLICY, ephemeral: true, effort: 'low', developerInstructions: DEV_NOTE });
  const ask = count > 1 ? `Generate ${count} images, one image generation call each.` : 'Generate one image.';
  const att = refs.length ? ` ${refs.length} reference image${refs.length > 1 ? 's are' : ' is'} attached (Image 1${refs.length > 1 ? `-Image ${refs.length}` : ''}).` : '';
  const input: UserInput[] = [
    { type: 'text', text: `${ask}${att}\n\n--- BRIEF ---\n${prompt}\n--- END BRIEF ---`, text_elements: [] },
    ...refs.map((path) => ({ type: 'localImage' as const, path })),
  ];
  let out: Outcome;
  try {
    out = await runTurn(thread, input, signal);
  } catch (e) {
    await thread.interrupt().catch(() => {});
    throw e;
  } finally {
    await thread.close();
  }

  const limit = out.items.find((i) => i.failure)?.failure;
  const stem = stemOf(prompt, args.filename);
  const images: SavedImage[] = [];
  for (const item of out.items) {
    if (item.failure || images.length >= count) continue;
    const data = await bytesOf(item);
    const kind = data && mimeOf(data);
    if (!data || !kind) continue;
    const path = await place(dir, count > 1 ? `${stem}-${images.length + 1}` : stem, kind.ext, data);
    const size = imageSize(data);
    images.push({ path, width: size?.w ?? null, height: size?.h ?? null, mime: kind.mime, data });
  }
  if (!images.length) {
    if (limit) throw new Error(`Codex hit its image generation limit (${limit.limitId}).${resetText(limit.resetsAt)}`);
    const why = out.error ?? out.turn.error?.message ?? (out.said ? `Codex said: ${oneLine(out.said, 300)}` : null);
    throw new Error(`Codex made no image${out.turn.status !== 'completed' ? ` (turn ${out.turn.status})` : ''}.${why ? ` ${why}` : ''}`);
  }
  return { images, asked: count, revised: out.items.flatMap((i) => (i.revisedPrompt ? [i.revisedPrompt] : [])), ms: Date.now() - started };
}
