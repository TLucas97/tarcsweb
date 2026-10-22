import type { IncomingMessage, ServerResponse } from 'node:http';
import { imageSize, localImageUrl, sameOrigin } from '../files.ts';
import {
  BOARD_API, BOARD_DEFAULT, CONTEXT_BYTES_MAX, CONTEXT_MAX, PROMPT_MAX, REGION_BYTES_MAX, REGION_PX_MAX, SUBMIT_BYTES_MAX, type BoardContext, type JobEvent, type ModelsReply,
  type SubmitBody,
} from './api.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { fakeAdapter } from './fake.ts';
import { boardJobs, JobError, type Listener } from './jobs.ts';

// The first one registered is the default.
boardJobs.register(codexAdapter);
boardJobs.register(claudeAdapter);
boardJobs.register(fakeAdapter);
// A prompt starting with "/fake" goes to the fake adapter, so the flow can be tried without spending Codex allowance.
const FAKE_PREFIX = /^\/fake\b\s*/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COORD_MAX = 100_000;
const ELEMENTS_MAX = 2000;
// Model ids and effort names.
const NAME = /^[\w.:-]{1,64}$/;

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    if ((n += c.length) > max) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const side = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= COORD_MAX;
const size = (v: unknown) => !!v && typeof v === 'object' && side((v as { w?: unknown }).w) && side((v as { h?: unknown }).h);
const optName = (v: unknown) => v === undefined || (typeof v === 'string' && NAME.test(v));
const coord = (v: unknown) => Number.isInteger(v) && Math.abs(v as number) <= COORD_MAX;

// Context is only text for the model, so it is checked for shape and size, not against the element schema.
function parseContext(v: unknown): BoardContext | null | undefined {
  if (v === undefined) return undefined;
  const c = v as Partial<BoardContext> | null;
  if (!c || typeof c !== 'object' || !Array.isArray(c.elements) || c.elements.length > CONTEXT_MAX) return null;
  if (!c.elements.every((e) => !!e && typeof e === 'object') || Buffer.byteLength(JSON.stringify(c.elements)) > CONTEXT_BYTES_MAX) return null;
  const o = c.overview;
  if (o === undefined) return { elements: c.elements };
  if (!o || typeof o.image !== 'string' || !UUID.test(o.image) || !o.box || !coord(o.box.x) || !coord(o.box.y) || !size(o.box)) return null;
  return { elements: c.elements, overview: { image: o.image, box: { x: o.box.x, y: o.box.y, w: o.box.w, h: o.box.h } } };
}

function parseSubmit(raw: unknown): SubmitBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const els = b.elements as SubmitBody['elements'] | undefined;
  if (typeof b.image !== 'string' || !UUID.test(b.image)) return null;
  if (!size(els) || !Array.isArray(els!.elements) || els!.elements.length > ELEMENTS_MAX) return null;
  if (typeof b.prompt !== 'string' || b.prompt.length > PROMPT_MAX) return null;
  if (!size(b.target) || !Number.isInteger(b.revision) || (b.revision as number) < 0) return null;
  if (b.provider !== undefined && (typeof b.provider !== 'string' || b.provider.length > 64)) return null;
  if (!optName(b.model) || !optName(b.effort) || (b.fast !== undefined && typeof b.fast !== 'boolean')) return null;
  const context = parseContext(b.context);
  if (context === null) return null;
  let prompt = b.prompt.trim(), provider = b.provider as string | undefined;
  const fake = FAKE_PREFIX.exec(prompt);
  if (fake) (provider = fakeAdapter.id), (prompt = prompt.slice(fake[0].length));
  return { image: b.image, elements: els!, prompt, target: b.target as SubmitBody['target'], revision: b.revision as number, context, provider, model: b.model as string | undefined, effort: b.effort as string | undefined, fast: b.fast as boolean | undefined };
}

// GET models -> ModelsReply; POST assets (PNG body) -> {id, url}; POST jobs (SubmitBody) -> {id}; GET jobs/:id/events
// (SSE of JobEvent, current state first); POST jobs/:id/cancel. Returns false for paths outside BOARD_API.
export async function serveBoard(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0];
  if (!path.startsWith(`${BOARD_API}/`)) return false;
  const reply = (code: number, body?: object) => void res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body ? JSON.stringify(body) : '');
  if (!sameOrigin(req)) return reply(403), true;
  const parts = path.slice(BOARD_API.length + 1).split('/');
  const post = req.method === 'POST';

  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'models') {
    const lists = boardJobs.withModels();
    const got = await Promise.allSettled(lists.map((a) => a.models!()));
    const errors = got.flatMap((g, i) => (g.status === 'rejected' ? [`${lists[i].label}: ${(g.reason as Error)?.message || 'could not list models'}`] : []));
    const out: ModelsReply = {
      models: got.flatMap((g) => (g.status === 'fulfilled' ? g.value : [])), default: boardJobs.adapter()?.defaults ?? BOARD_DEFAULT,
      error: errors.length ? errors.join('; ').slice(0, 300) : null,
    };
    return reply(200, out), true;
  }

  if (post && parts.length === 1 && parts[0] === 'assets') {
    const png = await readBody(req, REGION_BYTES_MAX);
    if (!png) return reply(413, { error: 'The region image is too large' }), true;
    const wh = png[0] === 0x89 && png.toString('latin1', 1, 4) === 'PNG' ? imageSize(png) : null;
    if (!wh || wh.w < 1 || wh.h < 1 || wh.w > REGION_PX_MAX || wh.h > REGION_PX_MAX) return reply(400, { error: 'Expected a PNG up to 2000 px per side' }), true;
    const { id, path: file } = await boardJobs.addAsset(png, wh.w, wh.h);
    return reply(200, { id, url: localImageUrl(file, wh.w, wh.h) }), true;
  }

  if (post && parts.length === 1 && parts[0] === 'jobs') {
    const raw = await readBody(req, SUBMIT_BYTES_MAX);
    if (!raw) return reply(413, { error: 'The selection is too large to send' }), true;
    let body: SubmitBody | null = null;
    try {
      body = parseSubmit(JSON.parse(raw.toString('utf8')));
    } catch {}
    if (!body) return reply(400, { error: 'Bad job request' }), true;
    try {
      return reply(200, { id: boardJobs.submit(body) }), true;
    } catch (e) {
      return reply(e instanceof JobError ? e.status : 500, { error: (e as Error).message }), true;
    }
  }

  const id = parts[1];
  if (parts.length !== 3 || parts[0] !== 'jobs' || !UUID.test(id ?? '')) return reply(404), true;

  if (post && parts[2] === 'cancel') return reply(boardJobs.cancel(id) ? 204 : 404), true;

  if (req.method === 'GET' && parts[2] === 'events') {
    let pending: string | null = null;
    const send: Listener = (frame, end) => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      if (end) return void ((pending = null), res.end(frame));
      // A slow reader gets only the latest progress once its buffer drains.
      if (res.writableNeedDrain) pending = frame;
      else res.write(frame);
    };
    res.on('drain', () => {
      if (pending === null || res.writableEnded) return;
      const f = pending;
      pending = null;
      res.write(f);
    });
    let off: (() => void) | null;
    try {
      off = boardJobs.subscribe(id, send);
    } catch (e) {
      return reply(e instanceof JobError ? e.status : 500, { error: (e as Error).message }), true;
    }
    // Finished jobs replay their end and close right away.
    if (!off) send(`data: ${JSON.stringify({ type: 'failed', error: 'This job is gone; the server may have restarted' } satisfies JobEvent)}\n\n`, true);
    else if (res.writableEnded) off();
    else req.on('close', off);
    return true;
  }

  return reply(405), true;
}
