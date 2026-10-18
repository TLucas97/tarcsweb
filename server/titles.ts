import { homedir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { firstWords, type TitleJob } from './chapters.ts';
import { tuning } from './profile.ts';
import { oneLine } from './session.ts';
import type { ClaudeEffort as Effort, Provider } from './protocol.ts';
import { fullText } from './stretch.ts';
import { connect } from './connect.ts';
import { askCodex, type Asking } from './codex/helper.ts';

export type { Asking };

const MODEL = 'claude-haiku-5-5';
const DEBOUNCE_MS = 1500;
const BATCH = 10;
const TIMEOUT_MS = 45_000;

export type TitleResult = { title: string | null; name: string | null };
type Pending = TitleJob & { name: boolean; done: (r: TitleResult) => void };

const SYSTEM = 'You name parts of a coding session. Reply with JSON only, no prose and no code fence.';

function clean(s: unknown, maxWords: number) {
  if (typeof s !== 'string') return null;
  const t = oneLine(s, 80).replace(/^["'`*#\s]+|["'`*.\s]+$/g, '');
  const words = t.split(' ').filter(Boolean).slice(0, maxWords).join(' ');
  return words && words.length <= 60 ? words : null;
}

function promptFor(batch: Pending[]) {
  const items = batch.map((j, i) => {
    const reply = j.reply.trim() ? oneLine(fullText(j.reply).slice(-600), 600) : '(no reply text)';
    const files = j.files.length ? `\nFiles changed: ${j.files.slice(0, 8).join(', ')}` : '';
    return `Item ${i + 1}${j.name ? ' (also name the session)' : ''}\nPrompt: ${oneLine(j.prompt, 700)}\nReply, trimmed: ${reply}${files}`;
  });
  return [
    'Give each item a title of 2 to 5 words that says what this part of the session was about.',
    "Write each title in the same language as that item's prompt. Sentence case, no quotes, no final period.",
    'For an item marked "also name the session", add "name": 3 to 5 words naming the whole session, in the same language.',
    `Answer with a JSON array of ${batch.length} objects, in order, like [{"title":"..."},{"title":"...","name":"..."}].`,
    '',
    items.join('\n\n'),
  ].join('\n');
}

function parse(text: string, n: number): TitleResult[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let arr: unknown[] = [];
  try {
    if (start >= 0 && end > start) arr = JSON.parse(text.slice(start, end + 1));
  } catch {}
  return Array.from({ length: n }, (_, i) => {
    const o = (Array.isArray(arr) ? arr[i] : null) as { title?: unknown; name?: unknown } | null;
    return { title: clean(o?.title, 5), name: clean(o?.name, 5) };
  });
}

type Extra = { effort?: Effort; maxTokens?: number; timeoutMs?: number; model?: string; provider?: Provider };

// One cheap call (Haiku unless told otherwise): no settings, hooks, plugins, MCP or tools, and nothing saved to the session list.
// provider is the tab's; without one Claude answers while signed in, else a small Codex model.
export async function ask(prompt: string, track: (q: Asking | null) => void, system = SYSTEM, extra: Extra = {}) {
  const provider = extra.provider ?? (connect.status?.loggedIn === false ? 'codex' : 'claude');
  if (provider === 'codex') return askCodex(prompt, track, system, extra.timeoutMs ?? TIMEOUT_MS);
  const env: Record<string, string | undefined> = { ...process.env, ...(extra.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(extra.maxTokens) } : {}) };
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), extra.timeoutMs ?? TIMEOUT_MS);
  const q = query({
    prompt,
    options: {
      model: extra.model ?? MODEL, systemPrompt: system, maxTurns: 1, tools: [], allowedTools: [], settingSources: [], persistSession: false,
      strictMcpConfig: true, mcpServers: {}, thinking: { type: 'disabled' }, cwd: homedir(), env, abortController,
      ...(extra.effort ? { effort: extra.effort } : {}),
    },
  });
  track(q);
  try {
    for await (const m of q) if (m.type === 'result') return m.subtype === 'success' && !m.is_error ? m.result : null;
    return null;
  } finally {
    clearTimeout(timer);
    track(null);
  }
}

// Queues title requests from every session; a short debounce lets turns that end together share one call.
export class Titles {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private active: Asking | null = null;
  private closed = false;
  calls = 0;

  request(job: TitleJob, name: boolean, done: (r: TitleResult) => void) {
    if (this.closed) return done({ title: null, name: null });
    if (!tuning().modelTitles) return done({ title: firstWords(job.prompt), name: name ? firstWords(job.prompt) : null });
    this.queue.push({ ...job, name, done });
    this.schedule();
  }

  private schedule() {
    if (this.timer || this.running || !this.queue.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private async run() {
    if (!tuning().modelTitles) {
      for (const j of this.queue.splice(0)) j.done({ title: firstWords(j.prompt), name: j.name ? firstWords(j.prompt) : null });
      return;
    }
    this.running = true;
    const batch = this.queue.splice(0, BATCH);
    let results: TitleResult[] = batch.map(() => ({ title: null, name: null }));
    try {
      this.calls++;
      const text = await ask(promptFor(batch), (q) => (this.active = q));
      if (text) results = parse(text, batch.length);
    } catch (err) {
      console.error(`title call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    batch.forEach((j, i) => j.done(results[i]));
    this.running = false;
    this.schedule();
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.active?.close();
    for (const j of this.queue.splice(0)) j.done({ title: null, name: null });
  }
}
