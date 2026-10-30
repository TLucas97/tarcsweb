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

export type TitleResult = { title: string | null; name: string | null; spoken: string | null };
type Pending = TitleJob & { name: boolean; done: (r: TitleResult) => void };
export type Named = { name: string | null; spoken: string | null };
type Speak = { name: string; done: (spoken: string | null) => void };

const SYSTEM = 'You name parts of a coding session. Reply with JSON only, no prose and no code fence.';

// What the English notification voice reads instead of a name in another language.
const SPOKEN_RULE = 'translated into natural English. It is always English, even when the source is in Portuguese or another language: an English text-to-speech voice reads it. Same meaning, symbols spelled out, no paths, code or file names.';

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
    'For an item marked "also name the session", add "name": 3 to 5 words naming the whole session, in the same language,',
    `and "spoken": that name ${SPOKEN_RULE}`,
    `Answer with a JSON array of ${batch.length} objects, in order, like [{"title":"..."},{"title":"...","name":"...","spoken":"..."}].`,
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
    const o = (Array.isArray(arr) ? arr[i] : null) as { title?: unknown; name?: unknown; spoken?: unknown } | null;
    return { title: clean(o?.title, 5), name: clean(o?.name, 5), spoken: clean(o?.spoken, 6) };
  });
}

function namePrompt(prompt: string) {
  return [
    "Name a coding session after the goal of its first message: what the user wants done, not the words they used.",
    '"name": at most 5 words, in the same language the message is written in (an English message gets an English name), spelled correctly with its accents, sentence case, no quotes, no final period.',
    `"spoken": that name ${SPOKEN_RULE}`,
    'Answer with one JSON object like {"name":"...","spoken":"..."}.',
    '',
    `Message: ${oneLine(prompt, 1500)}`,
  ].join('\n');
}

function wholePrompt(current: string, ctx: { titles: string[]; turns: { prompt: string; reply: string }[] }) {
  const parts = ctx.turns.map((t, i) => `${i + 1}. ${ctx.titles[i]}: ${oneLine(t.prompt, 240)}`);
  const last = ctx.turns.slice(-3).map((t) => `Prompt: ${oneLine(t.prompt, 500)}\nReply, trimmed: ${t.reply.trim() ? oneLine(fullText(t.reply).slice(-400), 400) : '(no reply text)'}`);
  return [
    'Name a coding session after the work it has done as a whole, not only its first request. Weigh what most of it was about and where it is now.',
    `Its current name may be outdated: ${oneLine(current, 80)}`,
    '"name": at most 5 words, in the language most of the prompts are written in, spelled correctly with its accents, sentence case, no quotes, no final period.',
    `"spoken": that name ${SPOKEN_RULE}`,
    'Answer with one JSON object like {"name":"...","spoken":"..."}.',
    '',
    'Every part of the session, oldest first (title: prompt):',
    parts.join('\n'),
    '',
    'The latest turns:',
    last.join('\n\n'),
  ].join('\n');
}

function parseNamed(text: string): Named {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let o: { name?: unknown; spoken?: unknown } = {};
  try {
    if (start >= 0 && end > start) o = JSON.parse(text.slice(start, end + 1));
  } catch {}
  // Seven words of slack: the model runs a word or two over, and a cut at five can end on "do" or "the".
  return { name: clean(o?.name, 7), spoken: clean(o?.spoken, 8) };
}

function parseSpoken(text: string, n: number) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let arr: unknown[] = [];
  try {
    if (start >= 0 && end > start) arr = JSON.parse(text.slice(start, end + 1));
  } catch {}
  return Array.from({ length: n }, (_, i) => clean(Array.isArray(arr) ? arr[i] : null, 6));
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
  private speaks: Speak[] = [];
  private speakTimer: ReturnType<typeof setTimeout> | null = null;
  private naming = new Set<Asking>();
  calls = 0;

  // A new session's name from its first prompt, asked at once and alone so the tab is renamed while the turn runs.
  name(prompt: string): Promise<Named> {
    if (!tuning().modelTitles) return Promise.resolve({ name: null, spoken: null });
    return this.askName(namePrompt(prompt));
  }

  // Asked from the menu, so it runs even where Lite turns automatic titles off.
  nameWhole(current: string, ctx: { titles: string[]; turns: { prompt: string; reply: string }[] }): Promise<Named> {
    return this.askName(wholePrompt(current, ctx));
  }

  private async askName(prompt: string): Promise<Named> {
    if (this.closed) return { name: null, spoken: null };
    let mine: Asking | null = null;
    try {
      this.calls++;
      const text = await ask(prompt, (q) => {
        if (mine) this.naming.delete(mine);
        mine = q;
        if (q) this.naming.add(q);
      });
      return text ? parseNamed(text) : { name: null, spoken: null };
    } catch (err) {
      console.error(`session name call failed: ${err instanceof Error ? err.message : String(err)}`);
      return { name: null, spoken: null };
    }
  }

  // The English reading of a name the user typed or a restored tab kept; batched, so a boot with many tabs costs one call.
  speak(name: string, done: (spoken: string | null) => void) {
    if (this.closed || !tuning().modelTitles) return done(null);
    this.speaks.push({ name, done });
    this.speakTimer ??= setTimeout(() => void this.runSpeak(), DEBOUNCE_MS);
  }

  private async runSpeak() {
    this.speakTimer = null;
    const batch = this.speaks.splice(0, BATCH);
    if (this.speaks.length) this.speakTimer = setTimeout(() => void this.runSpeak(), DEBOUNCE_MS);
    let out: (string | null)[] = batch.map(() => null);
    try {
      this.calls++;
      const list = batch.map((b, i) => `${i + 1}. ${oneLine(b.name, 80)}`).join('\n');
      const text = await ask(`Write each session name ${SPOKEN_RULE}\nAnswer with a JSON array of ${batch.length} strings, in order.\n\n${list}`, () => {});
      if (text) out = parseSpoken(text, batch.length);
    } catch (err) {
      console.error(`spoken name call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    batch.forEach((b, i) => b.done(out[i]));
  }

  request(job: TitleJob, name: boolean, done: (r: TitleResult) => void) {
    if (this.closed) return done({ title: null, name: null, spoken: null });
    if (!tuning().modelTitles) return done({ title: firstWords(job.prompt), name: name ? firstWords(job.prompt) : null, spoken: null });
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
      for (const j of this.queue.splice(0)) j.done({ title: firstWords(j.prompt), name: j.name ? firstWords(j.prompt) : null, spoken: null });
      return;
    }
    this.running = true;
    const batch = this.queue.splice(0, BATCH);
    let results: TitleResult[] = batch.map(() => ({ title: null, name: null, spoken: null }));
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
    if (this.speakTimer) clearTimeout(this.speakTimer);
    this.active?.close();
    for (const q of this.naming) q.close();
    for (const j of this.queue.splice(0)) j.done({ title: null, name: null, spoken: null });
    for (const b of this.speaks.splice(0)) b.done(null);
  }
}
