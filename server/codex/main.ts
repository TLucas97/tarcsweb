import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Effort, GenImage, Mode, ServerEvent, Upload } from '../protocol.ts';
import { relText } from '../tools.ts';
import { CACHE_DIR } from '../config.ts';
import { imageSize, localImageUrl } from '../files.ts';
import { displayPath, failBrief, oneLine } from '../text.ts';
import { codexAccount } from './account.ts';
import { keepImage } from './images.ts';
import { changeDetail, changeTexts, describe, type CodexAsk } from './agents.ts';
import { endStates, ownTool, shell, startCards } from './history.ts';
import { hiddenThreads } from './hidden.ts';
import {
  archiveThread, CLAUDE_DOCS, forkThread, NATIVE_AGENTS_OFF, resumeThread, setThreadName, startThread, unarchiveThread, type ApprovalDecision, type CodexApproval, type CodexEvent,
  type CodexPolicy, type CodexThread, type McpStartup,
} from './threads.ts';
import { claudeUserDoc } from './claudeMd.ts';
import { TOOL_SERVERS } from '../mcpHost.ts';
import type { AdditionalContext, FileUpdateChange, ThreadItem, ThreadTokenUsage, Turn, TurnError, TurnPlanStep, UserInput } from './types.ts';
import { pdfNote, type Seg } from '../links.ts';

const textInput = (text: string): UserInput => ({ type: 'text', text, text_elements: [] });

// Messages waiting for the running turn to accept them (steer refused, compaction, turn still starting).
const QUEUE_MAX = 20;
// fileChange items kept for their approval cards, image generations for their elapsed time, streamed message ids.
const ITEMS_MAX = 50;
const REASONING_MAX = 2000;
export const OUTPUT_MAX = 4000;
// Codex keeps injected items in the thread history, so the full prompt goes again only when it changed.
const PROMPT_EVERY_TURN = false;
// Our MCP servers are optional, so a slow start delays the first turn by at most this much.
const THREAD_CONFIG = { 'tools.update_plan.enabled': true, mcp_optional_startup_grace_ms: 10_000, ...CLAUDE_DOCS, ...NATIVE_AGENTS_OFF };
const USER_DOC_HEAD = "# The user's global instructions\n\nThe user's own instructions for every project, from their Claude Code CLAUDE.md. Follow them here too; where they name a Claude Code feature you lack, use your nearest equivalent.";
const OWN_SERVERS: Record<string, string> = { app: 'questions, tables, plans and agents', visual: 'pictures', replay: 'replays', 'agents-panel': 'progress updates' };
const UPLOADS = resolve(CACHE_DIR, 'codex-uploads');
// The handoff fork only writes text: nothing runs and nothing asks.
const FORK_POLICY: CodexPolicy = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
const FORK_NOTE = 'This is a throwaway copy of the conversation, made only to write a handoff document. Do not call any tool; answer with the document as plain Markdown.';

type ToolEvent = Extract<ServerEvent, { type: 'tool' }>;
type ResultEvent = Extract<ServerEvent, { type: 'tool-result' }>;
type Msg = { id: string; input: UserInput[] };

// What the driver needs from its Session; the shared machinery (log, panel, ChangeLog, chapters) stays there.
export type MainHost = {
  cwd: string;
  sessionId: string;
  model: () => string;
  effort: () => Effort;
  mode: () => Mode;
  push: (e: ServerEvent) => void;
  text: (id: string, delta: string) => void;
  activity: (text: string) => void;
  tool: (e: ToolEvent) => void;
  // A queued message reached the model (steer accepted, or a new turn started with it).
  delivered: (id: string) => void;
  // Messages that will never reach the model; why is shown on the tab.
  notSent: (ids: string[], why: string) => void;
  turnStarted: () => void;
  // more: queued messages start the next turn right away.
  turnEnded: (ok: boolean, subtype: string, text: { id: string; text: string } | null, ms: number | null, more: boolean) => void;
  edited: (path: string, before: string | null, after: string | null, note: string | null, add: number, rm: number) => void;
  plan: (task: string, steps: TurnPlanStep[]) => void;
  usage: (u: ThreadTokenUsage) => void;
  compacting: (on: boolean) => void;
  ask: (a: CodexAsk) => Promise<ApprovalDecision>;
  failedCommand: (id: string, command: string, output: string) => void;
  // The app's MCP servers for this tab, as thread config entries.
  toolConfig: () => Record<string, unknown>;
  // A call to one of those servers, and its result; they render the same as on a Claude tab.
  ownTool: (id: string, name: string, input: unknown) => void;
  ownResult: (id: string, content: unknown, isError: boolean) => void;
  // The full instructions, the short per-turn reminder, and a one-off note (stretches opened).
  instructions: () => string;
  reminder: () => string;
  note: () => string | null;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cap = <K, V>(m: Map<K, V>, k: K, v: V) => {
  m.set(k, v);
  if (m.size > ITEMS_MAX) m.delete(m.keys().next().value!);
};
const devMessage = (text: string) => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
const resetText = (at: number | null) => (at ? ` It resets ${new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.` : '');

// The reset time of the window that ran out, from the account's last rate limit read.
function limitReset() {
  const l = codexAccount.limits;
  const full = [l?.primary, l?.secondary].filter((w) => w && w.usedPercent >= 100);
  const at = (full.length ? full : [l?.primary, l?.secondary]).map((w) => w?.resetsAt ?? 0).filter(Boolean).sort((a, b) => b - a)[0];
  return at ? at * 1000 : null;
}

export function errorMessage(e: TurnError) {
  if (e.codexErrorInfo === 'usageLimitExceeded') return `Codex usage limit reached.${resetText(limitReset())}`;
  return `Codex: ${oneLine(e.message, 400)}${e.additionalDetails ? ` (${oneLine(e.additionalDetails, 200)})` : ''}`;
}

// A Codex thread as a tab's main agent: turns, steering, the event mapping to the client protocol, and approvals.
export class CodexMain {
  private host: MainHost;
  private thread: CodexThread | null = null;
  // Kept after the thread object is gone, so a restarted app-server resumes it instead of starting over.
  threadId: string | null = null;
  private opening: Promise<CodexThread> | null = null;
  private unsub: () => void = () => {};
  private active = false;
  private stopAsked = false;
  private compactingNow = false;
  private queue: Msg[] = [];
  // One steer at a time; a turn end that lands meanwhile waits in ended, so the message in flight is neither lost nor sent twice.
  private steering = false;
  private ended: (() => void) | null = null;
  private unloading: Promise<void> | null = null;
  // Counts run() calls, so a late failure of an older run leaves the current one alone.
  private runs = 0;
  private changes = new Map<string, FileUpdateChange[]>();
  private started = new Map<string, number>();
  private streamed = new Map<string, true>();
  private reasoning = '';
  private reasoningId = '';
  private lastText: { id: string; text: string } | null = null;
  private sentPrompt: string | null = null;
  // The newest prompt as injected, re-sent after a compaction drops it.
  private lastPrompt: string | null = null;
  private name: string | null = null;
  private closed = false;
  // The user's CLAUDE.md as read at the last thread start; null when Codex has its own global AGENTS.md.
  private userDoc: string | null = null;
  private versionNoted = false;
  // Our MCP servers already reported failed on this thread, so a resume does not repeat the error.
  private mcpFailed = new Set<string>();

  constructor(host: MainHost) {
    this.host = host;
  }

  get busy() {
    return this.active;
  }

  // The thread is held in the app-server.
  get loaded() {
    return !!this.thread && !this.thread.closed;
  }

  // segs is a prompt with linked attachments; it keeps its order as mixed text and image items.
  async send(id: string, text: string, files: Upload[], segs?: Seg[] | null) {
    let input: UserInput[];
    try {
      input = segs ? await Promise.all(segs.map((s) => ('file' in s ? this.fileInput(s.file) : textInput(s.text)))) : await this.inputOf(text, files);
    } catch (e) {
      return this.host.notSent([id], `The attachment could not be saved (${errText(e)}).`);
    }
    if (this.closed) return;
    const msg = { id, input };
    if (!this.active) return void this.run([msg]);
    // Behind anything already queued, so messages keep their order.
    if (this.enqueue(msg)) await this.flushSteer();
  }

  // Frees an idle thread in the app-server; the next send resumes it by id.
  unload() {
    const t = this.thread;
    if (this.active || this.opening || !t || t.closed) return;
    this.unsub();
    this.thread = null;
    this.unloading = t.close().finally(() => (this.unloading = null));
  }

  // Takes a message back while it waits in the local queue; false once Codex has it.
  unqueue(id: string) {
    const i = this.queue.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  async interrupt() {
    if (!this.active) return;
    this.stopAsked = true;
    if (!this.thread?.turnId) return;
    try {
      await this.thread.interrupt();
    } catch (e) {
      this.host.push({ type: 'error', message: `Interrupt failed: ${errText(e)}` });
    }
  }

  // A read-only fork of the thread writes the handoff, so the doc comes from the model's full context; the tab's thread is untouched.
  // ephemeral reports whether Codex kept the fork off disk; otherwise it is hidden from the session list and archived.
  async writeHandoff(prompt: string, signal: AbortSignal): Promise<{ text: string; ephemeral: boolean }> {
    if (this.active) throw new Error('Session is busy, try again when it finishes');
    if (!this.threadId) throw new Error('Nothing to hand off yet; send a message first');
    const { model, effort } = await this.modelAndEffort();
    const opts = { cwd: this.host.cwd, model, effort: effort === 'low' ? 'low' as const : 'medium' as const, mode: this.host.mode(), policy: FORK_POLICY, developerInstructions: FORK_NOTE };
    let fork: Awaited<ReturnType<typeof forkThread>>;
    try {
      fork = await forkThread(this.threadId, { ...opts, ephemeral: true });
    } catch (e) {
      console.warn(`[codex] ephemeral fork refused, using a saved one: ${errText(e)}`);
      fork = await forkThread(this.threadId, opts);
    }
    const { thread, ephemeral } = fork;
    if (!ephemeral) void hiddenThreads.add(thread.id).catch((e: unknown) => console.warn('[codex] handoff fork not hidden', e));
    let text = '';
    let unsub = () => {};
    const stop = () => void thread.interrupt().catch(() => {}).finally(() => void thread.close());
    try {
      if (signal.aborted) throw new Error('Stopped');
      signal.addEventListener('abort', stop, { once: true });
      const done = new Promise<void>((resolve, reject) => {
        unsub = thread.subscribe((e) => {
          if (e.type === 'item-completed' && e.item.type === 'agentMessage' && e.item.text && (e.item.phase !== 'commentary' || !text)) text = e.item.text;
          else if (e.type === 'turn-completed') {
            if (e.turn.status === 'completed') resolve();
            else reject(new Error(e.turn.error ? errorMessage(e.turn.error) : `The handoff turn ended ${e.turn.status}`));
          } else if (e.type === 'closed') reject(new Error(signal.aborted ? 'Stopped' : `Codex stopped: ${e.reason}`));
        });
      });
      done.catch(() => {});
      await thread.startTurn(prompt, { model, effort: opts.effort });
      await done;
    } finally {
      signal.removeEventListener('abort', stop);
      unsub();
      await thread.close();
      if (!ephemeral) void archiveThread(thread.id).catch((e: unknown) => console.warn(`[codex] handoff fork not archived: ${errText(e)}`));
    }
    if (!text.trim()) throw new Error('The handoff came back empty');
    return { text, ephemeral };
  }

  // A saved thread that is not loaded yet is renamed in place, so the session list shows it right away.
  setName(name: string) {
    this.name = name;
    if (this.thread && !this.thread.closed) void this.thread.setName(name).catch(() => {});
    else if (this.threadId) void setThreadName(this.threadId, name).catch((e: unknown) => console.warn(`[codex] rename failed: ${errText(e)}`));
  }

  // Interrupts the turn and drops the thread; its pending approvals end as cancelled.
  async close() {
    this.closed = true;
    this.queue = [];
    const t = this.thread;
    if (t?.turnId) await t.interrupt().catch(() => {});
    await t?.close();
    void rm(join(UPLOADS, this.host.sessionId), { recursive: true, force: true }).catch(() => {});
  }

  // A full queue refuses the new message instead of dropping an older one unseen.
  private enqueue(msg: Msg) {
    if (this.queue.length >= QUEUE_MAX) {
      this.host.notSent([msg.id], `${QUEUE_MAX} messages are already waiting for Codex.`);
      return false;
    }
    this.queue.push(msg);
    return true;
  }

  private async steer(msg: Msg) {
    if (this.compactingNow || !this.thread?.turnId) return false;
    try {
      if (!(await this.thread.steer(msg.input))) return false;
    } catch {
      return false;
    }
    this.host.delivered(msg.id);
    return true;
  }

  // Queued messages go into the running turn once it can take them, oldest first.
  private async flushSteer() {
    if (this.steering) return;
    this.steering = true;
    try {
      while (this.queue.length && this.active && !this.ended && !this.closed) {
        const msg = this.queue.shift()!;
        if (await this.steer(msg)) continue;
        if (!this.closed) this.queue.unshift(msg);
        break;
      }
    } finally {
      this.steering = false;
      const end = this.ended;
      this.ended = null;
      end?.();
    }
  }

  // A turn end runs once no steer is in flight, so it sees the queue as it really is.
  private afterSteer(fn: () => void) {
    if (this.steering) this.ended ??= fn;
    else fn();
  }

  private async run(msgs: Msg[]) {
    const gen = ++this.runs;
    this.active = true;
    this.stopAsked = false;
    this.host.turnStarted();
    for (const m of msgs) this.host.delivered(m.id);
    try {
      const thread = await this.ensureThread();
      const { model, effort } = await this.modelAndEffort();
      const ctx = await this.context(thread);
      await thread.startTurn(msgs.flatMap((m) => m.input), { model, effort, mode: this.host.mode(), additionalContext: ctx });
    } catch (e) {
      this.afterSteer(() => this.runFailed(e, gen));
    }
  }

  // The turn never started, so the messages queued behind it are not sent either.
  private runFailed(e: unknown, gen: number) {
    // A lost thread may already have ended this run and started the next one.
    if (!this.active || gen !== this.runs) return;
    this.active = false;
    this.host.push({ type: 'error', message: errText(e) });
    this.host.turnEnded(false, 'error_during_execution', null, null, false);
    const left = this.queue.splice(0);
    if (left.length) this.host.notSent(left.map((m) => m.id), 'Codex could not start the turn, so the messages waiting for it were dropped.');
  }

  // The catalog decides: an unknown model fails with a clear message, an effort the model lacks falls back to its default.
  private async modelAndEffort() {
    const model = this.host.model();
    const effort = this.host.effort();
    const list = await codexAccount.models().catch(() => null);
    const m = list?.find((x) => x.id === model || x.model === model);
    if (list && !m) throw new Error(`Codex has no model named ${model}. Pick another one in the model menu.`);
    return { model, effort: m && !m.efforts.includes(effort) ? m.defaultEffort : effort };
  }

  private async ensureThread() {
    if (this.thread && !this.thread.closed) return this.thread;
    this.opening ??= this.open().finally(() => (this.opening = null));
    return this.opening;
  }

  private async open() {
    // An unload still unsubscribing would end the resumed thread object when it finishes.
    if (this.unloading) await this.unloading;
    const status = codexAccount.status?.signedIn ? codexAccount.status : await codexAccount.check();
    if (!status.installed) throw new Error('The codex CLI is not installed on this machine. Install it, then sign in from Settings > Account.');
    if (!status.signedIn) throw new Error(`Codex is not signed in${status.error ? ` (${status.error})` : ''}. Sign in from Settings > Account.`);
    const config = { ...THREAD_CONFIG, ...this.host.toolConfig() };
    const opts = { cwd: this.host.cwd, model: this.host.model(), effort: this.host.effort(), mode: this.host.mode(), config };
    const [thread, userDoc] = await Promise.all([
      this.threadId ? this.resume(this.threadId, opts) : startThread(opts),
      claudeUserDoc().catch((e: unknown) => (console.warn(`[codex] CLAUDE.md not read: ${errText(e)}`), null)),
    ]);
    if (this.closed) {
      void thread.close();
      throw new Error('The session closed');
    }
    // A resumed thread starts without our instructions in view.
    if (this.threadId) this.sentPrompt = null;
    if (thread.id !== this.threadId) this.mcpFailed.clear();
    this.userDoc = userDoc;
    this.thread = thread;
    this.threadId = thread.id;
    this.unsub = thread.subscribe((e) => this.on(e));
    for (const [name, s] of thread.mcp) this.mcpStatus(name, s);
    if (!status.versionOk && !this.versionNoted) {
      this.versionNoted = true;
      this.host.push({ type: 'error', message: `Codex ${status.version ?? '(unknown version)'} is installed, but tarcsweb was tested with ${status.testedVersion}.x. Some parts of this tab may not work.` });
    }
    thread.onApproval((a) => this.approve(a));
    if (this.name) void thread.setName(this.name).catch(() => {});
    return thread;
  }

  // Sending to an archived thread brings it back, as typing into an archived Claude session does.
  private async resume(id: string, opts: Parameters<typeof resumeThread>[1]) {
    try {
      return await resumeThread(id, opts);
    } catch (e) {
      if (!/archived/i.test(errText(e))) throw e;
      await unarchiveThread(id);
      return resumeThread(id, opts);
    }
  }

  // Codex keeps only ~1k tokens (head and tail) of each additionalContext entry, so the full prompt goes in as an injected developer message.
  private async context(thread: CodexThread): Promise<AdditionalContext> {
    const app = this.host.instructions();
    const user = this.userDoc ? `${USER_DOC_HEAD}\n\n${this.userDoc}` : null;
    const full = user ? `${app}\n\n${user}` : app;
    const note = this.host.note();
    const ctx: AdditionalContext = {};
    const turn = note ? `${this.host.reminder()}\n\n${note}` : this.host.reminder();
    const fresh = PROMPT_EVERY_TURN || full !== this.sentPrompt;
    const text = `<tarcsweb_ui>\n${full}\n</tarcsweb_ui>`;
    // Codex records an unchanged additionalContext entry only once, so the reminder goes in as its own item every turn.
    const items = [...(fresh ? [devMessage(text)] : []), devMessage(`<tarcsweb_turn>${turn}</tarcsweb_turn>`)];
    try {
      await thread.inject(items);
    } catch (e) {
      console.warn(`[codex] instructions not injected (${errText(e)}); sending them as additionalContext, which Codex cuts to ~1k tokens per entry`);
      // Its own entry, so the app prompt's length does not cut the user's instructions away.
      if (fresh) ctx.tarcsweb_ui = { value: app, kind: 'application' };
      if (fresh && user) ctx.user_instructions = { value: user, kind: 'application' };
      ctx.tarcsweb_turn = { value: turn, kind: 'application' };
    }
    if (fresh) {
      this.sentPrompt = full;
      this.lastPrompt = text;
    }
    return ctx;
  }

  // Compaction drops developer messages, so our instructions go back in right after it.
  private async reinject() {
    const text = this.lastPrompt;
    if (!text || !this.thread) return;
    try {
      await this.thread.inject([devMessage(text)]);
    } catch (e) {
      // The next turn sends the full prompt again instead.
      this.sentPrompt = null;
      console.warn(`[codex] instructions not re-injected after compaction: ${errText(e)}`);
    }
  }

  private async inputOf(text: string, files: Upload[]): Promise<UserInput[]> {
    const out: UserInput[] = [];
    const notes: string[] = [];
    for (const f of files) {
      const item = await this.fileInput(f);
      if (item.type === 'text') notes.push(item.text);
      else out.push(item);
    }
    const body = [...notes, text].filter((t) => t.trim()).join('\n\n');
    if (body) out.push(textInput(body));
    return out;
  }

  // Images go as image items; text files inline; PDFs are saved for the agent to read.
  private async fileInput(f: Upload): Promise<UserInput> {
    if (f.kind === 'image') return { type: 'image', url: `data:${f.mime};base64,${f.data}` };
    if (f.kind === 'text') return textInput(`File ${f.name}:\n\n${f.data}`);
    const dir = join(UPLOADS, this.host.sessionId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${randomUUID().slice(0, 8)}-${basename(f.name).replace(/[^\w.-]+/g, '_')}`);
    await writeFile(path, Buffer.from(f.data, 'base64'));
    return textInput(pdfNote(path));
  }

  private on(e: CodexEvent) {
    switch (e.type) {
      case 'turn-started':
        this.host.turnStarted();
        if (this.stopAsked) void this.thread?.interrupt().catch(() => {});
        else void this.flushSteer();
        return;
      case 'message-delta':
        this.streamed.set(e.itemId, true);
        if (this.streamed.size > ITEMS_MAX) this.streamed.delete(this.streamed.keys().next().value!);
        this.host.text(`cx:${e.itemId}`, e.delta);
        return;
      case 'reasoning-delta': {
        if (e.itemId !== this.reasoningId) {
          this.reasoningId = e.itemId;
          this.reasoning = '';
        }
        this.reasoning = (this.reasoning + e.delta).slice(-REASONING_MAX);
        const head = [...this.reasoning.matchAll(/\*\*(.+?)\*\*/g)].pop()?.[1];
        if (head) this.host.activity(oneLine(head, 80));
        return;
      }
      case 'item-started':
        return this.itemStarted(e.item);
      case 'item-completed':
        return void this.itemCompleted(e.item).catch((err: unknown) => console.error('[codex] completed item not handled', err));
      case 'plan':
        return this.host.plan(e.explanation ?? '', e.plan);
      case 'tokens':
        return this.host.usage(e.usage);
      case 'error':
        if (!e.willRetry) this.host.push({ type: 'error', message: errorMessage(e.error) });
        return;
      case 'status':
        if (e.status.type === 'systemError') this.host.push({ type: 'error', message: 'Codex reported a system error on this thread.' });
        return;
      case 'mcp-status':
        return this.mcpStatus(e.name, e);
      case 'turn-completed':
        return this.afterSteer(() => this.turnDone(e.turn));
      case 'closed':
        return this.lost(e.reason);
    }
  }

  // One of the app's MCP servers failed to start, so its tools are missing from this thread.
  private mcpStatus(name: string, s: McpStartup) {
    if (s.status !== 'failed' || !TOOL_SERVERS.includes(name) || this.mcpFailed.has(name)) return;
    this.mcpFailed.add(name);
    const why = s.error ? `: ${oneLine(s.error, 200)}` : '.';
    this.host.push({ type: 'error', message: `The app's ${name} tools (${OWN_SERVERS[name] ?? 'visuals, questions, progress'}) are unavailable on this tab. Codex could not start them${why}` });
  }

  private turnDone(turn: Turn) {
    if (!this.active) return;
    this.active = false;
    if (turn.status === 'failed' && turn.error) this.host.push({ type: 'error', message: errorMessage(turn.error) });
    const text = this.lastText;
    this.lastText = null;
    this.reasoning = '';
    if (this.compactingNow) {
      this.compactingNow = false;
      this.host.compacting(false);
    }
    const next = this.queue.splice(0);
    this.host.turnEnded(turn.status === 'completed', turn.status, text, turn.durationMs, next.length > 0);
    if (next.length && !this.closed) void this.run(next);
  }

  // The app-server went away; the next turn resumes the thread by id.
  private lost(reason: string) {
    this.unsub();
    this.thread = null;
    this.afterSteer(() => this.lostTurn(reason));
  }

  private lostTurn(reason: string) {
    if (this.closed || !this.active) return;
    this.active = false;
    this.host.push({ type: 'error', message: `Codex stopped: ${reason}` });
    const next = this.queue.splice(0);
    this.host.turnEnded(false, 'error_during_execution', null, null, next.length > 0);
    if (next.length) void this.run(next);
  }

  private itemStarted(item: ThreadItem) {
    const cwd = this.host.cwd;
    const line = describe(cwd, item);
    if (line) this.host.activity(item.type === 'agentMessage' ? 'Writing a reply' : line);
    if (item.type === 'mcpToolCall' && ownTool(item)) return this.host.ownTool(`cx:${item.id}`, `mcp__${item.server}__${item.tool}`, item.arguments);
    if (item.type === 'fileChange') cap(this.changes, item.id, item.changes);
    if (item.type === 'imageGeneration') cap(this.started, item.id, Date.now());
    if (item.type === 'contextCompaction') {
      this.compactingNow = true;
      return this.host.compacting(true);
    }
    for (const e of startCards(cwd, item)) this.host.tool(e);
  }

  private async itemCompleted(item: ThreadItem) {
    const cwd = this.host.cwd;
    const id = `cx:${item.id}`;
    const result = (error: string | null, extra: Partial<ResultEvent> = {}) => this.host.push({ type: 'tool-result', id, error, ...extra });
    switch (item.type) {
      case 'agentMessage':
        // A message that never streamed as deltas still belongs in the conversation.
        if (!this.streamed.has(item.id) && item.text) this.host.text(id, item.text);
        this.streamed.delete(item.id);
        if (item.text && item.phase !== 'commentary') this.lastText = { id, text: item.text };
        else if (item.text && !this.lastText) this.lastText = { id, text: item.text };
        return;
      case 'commandExecution': {
        const [[, error]] = endStates(item);
        const out = item.aggregatedOutput ?? '';
        const kept = !!error && item.status !== 'declined' && !this.stopAsked;
        result(error, kept && out ? { brief: failBrief(out) } : {});
        if (kept) this.host.failedCommand(id, shell(item.command), out);
        return;
      }
      case 'fileChange': {
        this.changes.delete(item.id);
        for (const [cid, error] of endStates(item)) this.host.push({ type: 'tool-result', id: cid, error });
        if (item.status !== 'completed') return;
        for (const c of item.changes) {
          try {
            const t = await changeTexts(cwd, c);
            this.host.edited(t.dest, t.before, t.after, t.note, t.add, t.rm);
          } catch (e) {
            console.warn('[codex] file change not recorded', e);
          }
        }
        return;
      }
      case 'webSearch': {
        const q = item.query || item.action?.query || item.action?.url || 'the web';
        this.host.tool({ type: 'tool', id, name: 'WebSearch', verb: 'web', summary: oneLine(q) });
        return result(null);
      }
      case 'mcpToolCall': {
        if (!ownTool(item)) return result(endStates(item)[0][1]);
        const content = item.result?.content ?? (item.error?.message ? [{ type: 'text', text: item.error.message }] : []);
        return this.host.ownResult(id, content, item.status === 'failed' || !!item.error);
      }
      case 'dynamicToolCall':
      case 'collabAgentToolCall':
        return result(endStates(item)[0][1]);
      case 'imageView': {
        const size = await readFile(item.path).then(imageSize, () => null);
        return result(null, { img: localImageUrl(item.path, size?.w ?? 0, size?.h ?? 0) });
      }
      case 'imageGeneration': {
        const ms = Date.now() - (this.started.get(item.id) ?? Date.now());
        this.started.delete(item.id);
        if (item.failure) return result(`Codex hit its image generation limit (${item.failure.limitId}).${resetText(item.failure.resetsAt ? item.failure.resetsAt * 1000 : null)}`, { ms });
        const kept = await keepImage(item).catch((e: unknown) => {
          console.warn(`[codex] image not copied to AI Images: ${errText(e)}`);
          return null;
        });
        const path = kept ?? item.savedPath;
        if (!path) return result('Codex made no image file', { ms });
        const size = await readFile(path).then(imageSize, () => null);
        const images: GenImage[] = [{ path, src: localImageUrl(path, size?.w ?? 0, size?.h ?? 0) }];
        return result(null, { images, ms });
      }
      case 'contextCompaction':
        this.compactingNow = false;
        this.host.compacting(false);
        await this.reinject();
        return void this.flushSteer();
    }
  }

  private async approve(a: CodexApproval): Promise<ApprovalDecision> {
    const title = `Codex${a.reason ? ` — ${oneLine(a.reason, 160)}` : ''}`;
    if (a.kind === 'command') {
      return this.host.ask({ agentId: 'main', tool: 'Bash', summary: oneLine(relText(this.host.cwd, shell(a.command ?? 'a command')), 300), title, detail: null, signal: a.signal });
    }
    if (a.kind === 'fileChange') {
      const changes = this.changes.get(a.itemId) ?? [];
      const paths = changes.map((c) => displayPath(this.host.cwd, resolve(this.host.cwd, c.path)));
      const detail = changes.length === 1 ? changeDetail(this.host.cwd, changes[0]) : null;
      const tool = changes.length && changes.every((c) => c.kind.type === 'add') ? 'Write' : 'Edit';
      return this.host.ask({ agentId: 'main', tool, summary: paths.join(', ') || a.grantRoot || 'files', title, detail, signal: a.signal });
    }
    const want = Object.entries((a.permissions ?? {}) as Record<string, unknown>).filter(([, v]) => v != null).map(([k]) => (k === 'fileSystem' ? 'file system' : k));
    return this.host.ask({ agentId: 'main', tool: 'Permissions', summary: `More access: ${want.join(', ') || 'unspecified'}`, title, detail: null, signal: a.signal });
  }
}
