import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type EffortLevel, type ModelInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { connect } from '../connect.ts';
import { MODEL_IDS } from '../protocol.ts';
import type { BoardModel } from './api.ts';
import { generating, type BoardAdapter, type JobInput } from './jobs.ts';
import { shrinkPng } from './png.ts';
import { boardInstructions, boardMessage } from './prompt.ts';

const STEPS = 4;
// Streaming text progress, at most this often.
const PROGRESS_MS = 300;
const MODELS_TTL = 6 * 3600_000;
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT = { model: 'claude-sonnet-5-5', effort: 'high' };
// The Messages API's per-image limit applies to the base64 text.
const IMAGE_B64_MAX = 5 << 20;
const IMAGE_MAX = Math.floor((IMAGE_B64_MAX * 3) / 4);
// Bound on each step of stopping the CLI: its own exit, then SIGTERM, then SIGKILL.
const EXIT_MS = 2_500;
// The only variables the CLI gets: no inherited effort, endpoint or header overrides. The last three are auth it may use.
const ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

const known = (id: string, name: string, description: string): BoardModel => ({ id, name, description, isDefault: id === DEFAULT.model, efforts: EFFORTS, defaultEffort: 'high', tiers: [], provider: 'claude' });
// Until a job has asked the CLI for the account's list; Fable shows up only once the account lists it.
const KNOWN: BoardModel[] = [
  known('claude-opus-5-5', 'Opus 5.5', 'Complex, multi-step work'),
  known('claude-sonnet-5-5', 'Sonnet 5.5', 'Everyday work'),
  known('claude-haiku-5-5', 'Haiku 5.5', 'Quick answers'),
];

let found: { at: number; models: BoardModel[] } | null = null;

// The list a past job discovered while fresh, else KNOWN; listing and submit both read it. Never starts a process.
const catalog = () => (found && Date.now() - found.at < MODELS_TTL ? found.models : KNOWN);

// The CLI's list, narrowed to the current family; alias rows ("opus") carry the full id in resolvedModel.
function remember(rows: ModelInfo[]) {
  const seen = new Set<string>(), out: BoardModel[] = [];
  for (const r of rows) {
    const id = r.resolvedModel ?? r.value;
    if (r.value === 'default' || !MODEL_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    const efforts = (r.supportedEffortLevels ?? []).filter((e) => EFFORTS.includes(e));
    out.push({ ...known(id, r.displayName, r.description), efforts, defaultEffort: efforts.includes('high') ? 'high' : (efforts.at(-1) ?? '') });
  }
  if (out.length) found = { at: Date.now(), models: out };
}

// Effort is left out for a model that offers none.
function pick(input: JobInput) {
  const models = catalog();
  const m = models.find((x) => x.id === input.model) ?? models.find((x) => x.id === DEFAULT.model) ?? models[0];
  const want = input.effort || DEFAULT.effort;
  return { model: m.id, effort: (m.efforts.includes(want) ? want : m.defaultEffort) as EffortLevel | '' };
}

// A job PNG as base64, halved until it fits the image limit; w and h are what the model is told.
async function pngImage(file: { path: string; w: number; h: number }) {
  const png = await readFile(file.path);
  if (png.length <= IMAGE_MAX) return { data: png.toString('base64'), w: file.w, h: file.h };
  const small = await shrinkPng(png, IMAGE_MAX);
  if (!small) throw new Error('The selection image is too large for Claude; select a smaller region');
  return { data: small.png.toString('base64'), w: small.w, h: small.h };
}

function cliEnv() {
  const env: Record<string, string> = {};
  for (const k of ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  return env;
}

const cancelled = () => new Error('Cancelled');
const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

// Resolves once the CLI is really gone, so the job slot never frees while it still runs.
async function reap(c: ChildProcess | null) {
  if (!c || c.pid === undefined || exited(c)) return;
  const gone = new Promise<void>((r) => c.once('exit', () => r()));
  const wait = () => Promise.race([gone.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(exited(c)), EXIT_MS).unref())]);
  if (await wait()) return;
  c.kill('SIGTERM');
  if (await wait()) return;
  c.kill('SIGKILL');
  await gone;
}

async function* one(message: SDKUserMessage['message']): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message, parent_tool_use_id: null };
}

// One tool-less Claude query per job: the same instructions and message as Codex, the region PNG as an image block.
export const claudeAdapter: BoardAdapter = {
  id: 'claude',
  label: 'Claude',
  capabilities: { elements: true },
  models: async () => catalog(),
  defaults: DEFAULT,
  async submit(input, emit, signal) {
    const t0 = Date.now();
    const marks: Record<string, number> = {};
    const mark = (k: string) => void (marks[k] ??= Date.now() - t0);
    emit({ step: 1, of: STEPS, text: 'Starting Claude' });
    if (connect.status?.loggedIn === false) throw new Error('Claude is not signed in; sign in from Settings > Account');
    const { model, effort } = pick(input);
    const fresh = generating(input);
    // An empty region's PNG is blank, so it is left out, as for Codex.
    const image = fresh ? null : await pngImage(input.image);
    const overview = input.overview ? await pngImage(input.overview) : null;
    if (signal.aborted) throw cancelled();
    // A fresh empty folder as cwd: no project CLAUDE.md, rules or auto-memory, and nothing personal in its path.
    const cwd = await mkdtemp(join(tmpdir(), 'board-'));
    const abortController = new AbortController();
    let child: ChildProcess | null = null;
    // SIGTERM right away: the SDK's graceful close lets a running request go on for ~2 s.
    const onAbort = () => {
      abortController.abort();
      const c = child as ChildProcess | null;
      if (c && !exited(c)) c.kill('SIGTERM');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const message = boardMessage({
      ...input, ...(image && { image: { ...input.image, w: image.w, h: image.h } }), ...(overview && input.overview && { overview: { ...input.overview, w: overview.w, h: overview.h } }),
    });
    // Same order as boardImages: the region, then the overview.
    const pictures = [image, overview].filter((p) => !!p).map((p) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: p.data } }));
    const q = query({
      prompt: one({ role: 'user', content: [...pictures, { type: 'text' as const, text: message }] }),
      options: {
        model, ...(effort && { effort }), systemPrompt: boardInstructions(input.schema), maxTurns: 1, cwd, env: cliEnv(), abortController,
        // Nothing of the owner's setup: no settings files, hooks, memory, skills, plugins, MCP or tools, and no transcript.
        tools: [], allowedTools: [], settingSources: [], skills: [], strictMcpConfig: true, mcpServers: {}, persistSession: false,
        // Residual risk: admin managed settings (/etc/claude-code) would still apply; this machine has none.
        settings: { autoMemoryEnabled: false, disableAllHooks: true }, verbatimPrompts: true, includePartialMessages: true,
        // A fixed title skips the CLI's side call that would send the job to a model just to name the session.
        title: 'Board job',
        // Our own spawn, so the slot is held until the process has exited; the SDK's signal fires after its grace period.
        spawnClaudeCodeProcess: (o) => {
          const c = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'ignore'] });
          o.signal.addEventListener('abort', () => void (exited(c) || c.kill('SIGTERM')), { once: true });
          child = c;
          return c;
        },
      },
    });
    // The job's own process answers the model list for later pickers.
    q.supportedModels().then(remember, () => {});
    let outcome = 'done', chars = 0, shown = 0, usage = '';
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          mark('init');
          emit({ step: 2, of: STEPS, text: fresh ? 'Reading the request' : 'Reading the sketch' });
        } else if (m.type === 'stream_event') {
          const e = m.event;
          if (e.type === 'content_block_start' && e.content_block.type === 'thinking' && !('text' in marks)) {
            mark('thinking');
            emit({ step: 3, of: STEPS, text: fresh ? 'Planning the layout' : 'Working out the shapes' });
          } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
            mark('text');
            chars += e.delta.text.length;
            if (Date.now() - shown >= PROGRESS_MS) {
              shown = Date.now();
              emit({ step: 4, of: STEPS, text: `Claude is drawing… ${chars} chars` });
            }
          }
        } else if (m.type === 'result') {
          const u = m.usage;
          usage = ` · in ${u.input_tokens} (cache read ${u.cache_read_input_tokens}, write ${u.cache_creation_input_tokens}) out ${u.output_tokens} tok`;
          if (m.subtype === 'success' && !m.is_error && m.result.trim()) return { json: m.result };
          throw new Error(`Claude gave no answer${m.subtype === 'success' ? (m.is_error ? `: ${m.result}` : '') : `: ${m.errors[0] ?? m.subtype}`}`);
        }
      }
      throw signal.aborted ? cancelled() : new Error('Claude gave no answer');
    } catch (e) {
      const err = signal.aborted ? cancelled() : e instanceof Error ? e : new Error(String(e));
      outcome = signal.aborted ? 'cancelled' : `failed (${err.message})`;
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
      q.close();
      const t1 = Date.now();
      await reap(child);
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
      const at = ['init', 'thinking', 'text'].filter((k) => k in marks).map((k) => `${k} ${marks[k]}`).join(' · ');
      console.log(`[board] claude ${model}/${effort || '-'} ${fresh ? 'generate' : 'refine'} ${input.target.w}x${input.target.h} ${input.elements.elements.length} els, context ${input.context.length}${overview ? `, overview ${overview.w}x${overview.h}` : ''}: ${at} · ${outcome} ${t1 - t0} ms · ${chars} chars${usage} · exit ${Date.now() - t1} ms`);
    }
  },
};
