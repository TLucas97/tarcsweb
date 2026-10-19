import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { tuning } from '../profile.ts';
import { OVERVIEW_PX_MAX, RESULT_BYTES_MAX, type BoardModel, type JobEvent, type SubmitBody } from './api.ts';
import { BOARD_SCHEMA } from './schema.ts';

// What an adapter gets: the same for a fake, Codex or any later model.
export type JobInput = {
  // The region PNG on disk: transparent, clipped to the lasso, numbered marks matching the element ids.
  image: { path: string; w: number; h: number };
  elements: SubmitBody['elements'];
  prompt: string;
  // BOARD_SCHEMA: how to write the answer.
  schema: string;
  target: { w: number; h: number };
  // Read-only neighbours in region coordinates (empty when nothing stays around the region), and the whole drawing
  // scaled down with the region outlined; `box` is the area the overview shows, in region coordinates.
  context: unknown[];
  overview: { path: string; w: number; h: number; box: { x: number; y: number; w: number; h: number } } | null;
  revision: number;
  // The person's pick; an adapter without such choices ignores them.
  model?: string;
  effort?: string;
  fast?: boolean;
};

// No elements means the region is empty: the model draws the prompt from scratch instead of cleaning up.
export const generating = (input: Pick<JobInput, 'elements'>) => input.elements.elements.length === 0;

export type Progress = { step: number; of: number; text: string };

// A model behind the board's refine flow. submit resolves with the model's answer text (raw, fenced or in prose;
// the registry extracts the JSON) or rejects with a readable error; it must stop soon after `signal` aborts.
export type BoardAdapter = {
  id: string;
  label: string;
  capabilities: { elements: boolean };
  // The models a person can pick per job, with their efforts; absent when the adapter has no choice to offer.
  models?(): Promise<BoardModel[]>;
  defaults?: { model: string; effort: string };
  submit(input: JobInput, emit: (p: Progress) => void, signal: AbortSignal): Promise<{ json: string }>;
};

// Gets each event already serialized as one SSE frame; `end` marks the last one.
export type Listener = (frame: string, end: boolean) => void;

type State = 'running' | 'done' | 'failed' | 'cancelled';
type Job = {
  id: string;
  state: State;
  // Latest progress frame and the final frame, replayed to late subscribers.
  last: string | null;
  end: string | null;
  ctrl: AbortController;
  listeners: Set<Listener>;
  // The region PNG, then the overview PNG when there is one.
  paths: string[];
  // The running deadline, then the drop timer of a finished job.
  timer: NodeJS.Timeout | null;
  // The adapter has not settled yet; a cancelled job keeps its slot until the model has really stopped.
  busy: boolean;
};
type Asset = { path: string; w: number; h: number; timer: NodeJS.Timeout };

export const BOARD_DIR = join(CACHE_DIR, 'board');
// Stored jobs, finished ones included; each owns its region and overview PNGs until it is dropped.
const JOBS_MAX = 20;
const JOB_TTL = 30 * 60_000;
// Uploaded PNGs no job has claimed yet.
const ASSETS_MAX = 8;
const ASSET_TTL = 10 * 60_000;
// Open event streams per job (a page and a reconnect or two).
const SUBS_MAX = 4;
// Leftovers of a killed server are swept on upload or submit, at most this often.
const SWEEP_EVERY = 10 * 60_000;
const ERROR_MAX = 500;

export class JobError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const drop = (path: string) => void rm(path, { force: true }).catch(() => {});
const frame = (e: JobEvent) => `data: ${JSON.stringify(e)}\n\n`;

// One JSON payload from a model's answer: the whole text, a ```json fence, or the first balanced object in prose.
// Anything else comes back as is, so the client's validator reports it.
export function jsonPayload(text: string): string {
  const t = text.trim();
  const parses = (s: string) => {
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  };
  if (parses(t)) return t;
  for (const m of t.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)) if (parses(m[1].trim())) return m[1].trim();
  for (let start = t.indexOf('{'); start >= 0; start = t.indexOf('{', start + 1)) {
    let depth = 0, str = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (str) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') str = false;
      } else if (c === '"') str = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        const s = t.slice(start, i + 1);
        if (parses(s)) return s;
        break;
      }
    }
  }
  return text;
}

class BoardJobs {
  private adapters = new Map<string, BoardAdapter>();
  private jobs = new Map<string, Job>();
  private assets = new Map<string, Asset>();
  private dir: Promise<unknown> | null = null;
  private swept = 0;

  register(a: BoardAdapter) {
    this.adapters.set(a.id, a);
  }

  list() {
    return [...this.adapters.values()].map(({ id, label, capabilities }) => ({ id, label, capabilities }));
  }

  // Adapters that offer a model pick, in registration order.
  withModels() {
    return [...this.adapters.values()].filter((a) => a.models);
  }

  // The default adapter unless one is named.
  adapter(id?: string) {
    return this.adapters.get(id ?? this.adapters.keys().next().value ?? '');
  }

  async addAsset(png: Buffer, w: number, h: number) {
    await this.ready();
    this.sweep();
    const id = randomUUID(), path = join(BOARD_DIR, `${id}.png`);
    await writeFile(path, png, { flag: 'wx' });
    while (this.assets.size >= ASSETS_MAX) this.dropAsset(this.assets.keys().next().value!);
    this.assets.set(id, { path, w, h, timer: setTimeout(() => this.dropAsset(id), ASSET_TTL).unref() });
    return { id, path };
  }

  submit(body: SubmitBody): string {
    const adapter = this.adapter(body.provider);
    if (!adapter?.capabilities.elements) throw new JobError(400, 'Unknown provider');
    if (generating(body) && !body.prompt) throw new JobError(400, 'The selection is empty; describe what to draw there');
    const asset = this.assets.get(body.image);
    if (!asset) throw new JobError(404, 'The region image expired; try again');
    const ov = body.context?.overview, overview = ov ? this.assets.get(ov.image) : null;
    if (ov && (!overview || ov.image === body.image)) throw new JobError(404, 'The overview image expired; try again');
    if (overview && Math.max(overview.w, overview.h) > OVERVIEW_PX_MAX) throw new JobError(400, `Expected an overview up to ${OVERVIEW_PX_MAX} px per side`);
    let running = 0;
    for (const j of this.jobs.values()) if (j.busy) running++;
    if (running >= tuning().boardJobs) throw new JobError(429, 'Another refine is still running');
    this.sweep();
    for (const id of [body.image, ...(ov ? [ov.image] : [])]) {
      clearTimeout(this.assets.get(id)!.timer);
      this.assets.delete(id);
    }
    const job: Job = {
      id: randomUUID(), state: 'running', busy: true, last: null, end: null, ctrl: new AbortController(), listeners: new Set(), paths: [asset.path, ...(overview ? [overview.path] : [])],
      timer: null,
    };
    this.jobs.set(job.id, job);
    this.trim();
    const ms = tuning().boardJobMs;
    job.timer = setTimeout(() => {
      this.finish(job, 'failed', { type: 'failed', error: `No answer after ${Math.round(ms / 1000)} s; try again` });
      job.ctrl.abort();
    }, ms).unref();
    const input: JobInput = {
      image: { path: asset.path, w: asset.w, h: asset.h }, elements: body.elements, prompt: body.prompt, schema: BOARD_SCHEMA, target: body.target, revision: body.revision,
      context: body.context?.elements ?? [], overview: overview && ov ? { path: overview.path, w: overview.w, h: overview.h, box: ov.box } : null,
      model: body.model, effort: body.effort, fast: body.fast,
    };
    const t0 = Date.now();
    const emit = (p: Progress) => {
      if (job.state !== 'running') return;
      job.last = frame({ type: 'progress', step: p.step, of: p.of, text: String(p.text).slice(0, 200) });
      for (const fn of job.listeners) fn(job.last, false);
    };
    adapter.submit(input, emit, job.ctrl.signal).then(
      ({ json }) => {
        if (typeof json !== 'string') return this.finish(job, 'failed', { type: 'failed', error: 'The model returned no elements' });
        const payload = jsonPayload(json);
        if (Buffer.byteLength(payload) > RESULT_BYTES_MAX) return this.finish(job, 'failed', { type: 'failed', error: 'The model returned too much to place' });
        this.finish(job, 'done', { type: 'done', json: payload, revision: body.revision, ms: Date.now() - t0 });
      },
      (err: unknown) => {
        const error = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX) || 'The job failed';
        this.finish(job, 'failed', { type: 'failed', error });
      },
    ).finally(() => void (job.busy = false));
    return job.id;
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'running') {
      this.finish(job, 'cancelled', { type: 'cancelled' });
      job.ctrl.abort();
    }
    return true;
  }

  // Replays the current state, then streams; null for an unknown job. A finished job replays only its end.
  subscribe(id: string, fn: Listener): (() => void) | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.end) {
      fn(job.end, true);
      return () => {};
    }
    if (job.listeners.size >= SUBS_MAX) throw new JobError(429, 'Too many streams for this job');
    if (job.last) fn(job.last, false);
    job.listeners.add(fn);
    return () => void job.listeners.delete(fn);
  }

  private finish(job: Job, state: State, e: JobEvent) {
    if (job.state !== 'running') return;
    job.state = state;
    job.end = frame(e);
    job.last = null;
    for (const fn of job.listeners) fn(job.end, true);
    job.listeners.clear();
    clearTimeout(job.timer!);
    job.timer = setTimeout(() => this.dropJob(job.id), JOB_TTL).unref();
  }

  // Oldest finished jobs go first; running ones are capped by tuning().boardJobs instead.
  private trim() {
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= JOBS_MAX) return;
      if (!j.busy) this.dropJob(id);
    }
  }

  private dropJob(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.busy) return;
    clearTimeout(job.timer!);
    this.jobs.delete(id);
    job.paths.forEach(drop);
  }

  private dropAsset(id: string) {
    const a = this.assets.get(id);
    if (!a) return;
    clearTimeout(a.timer);
    this.assets.delete(id);
    drop(a.path);
  }

  private ready() {
    this.dir ??= mkdir(BOARD_DIR, { recursive: true });
    return this.dir;
  }

  // Files older than the age limit that no live job or upload holds; other servers sharing the dir keep theirs.
  private sweep() {
    const now = Date.now();
    if (now - this.swept < SWEEP_EVERY) return;
    this.swept = now;
    const live = new Set([...[...this.jobs.values()].flatMap((j) => j.paths), ...[...this.assets.values()].map((a) => a.path)]);
    const age = tuning().boardFileMs;
    void (async () => {
      try {
        for (const name of await readdir(BOARD_DIR)) {
          const p = join(BOARD_DIR, name);
          const st = live.has(p) ? null : await stat(p).catch(() => null);
          if (st && now - st.mtimeMs > age) drop(p);
        }
      } catch {}
    })();
  }
}

export const boardJobs = new BoardJobs();
