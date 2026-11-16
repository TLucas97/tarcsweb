import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { Effort, Mode, ServerEvent, Upload } from '../protocol.ts';
import { cardCommand, relText, resultText } from '../tools.ts';
import { displayPath, oneLine } from '../text.ts';
import { changeDetail, changeTexts, type CodexAsk } from '../codex/agents.ts';
import type { ApprovalDecision } from '../codex/threads.ts';
import type { FileUpdateChange } from '../codex/types.ts';
import type { RoundInput, RoundSent } from '../appTools.ts';
import { pdfNote, type Seg } from '../links.ts';
import { saveUpload } from '../codex/uploads.ts';
import { TOOL_SERVERS } from '../mcpHost.ts';
import { opencode, type FileDiff, type FormAnswer, type FormInfo, type ModelInfo, type PermissionRequest } from './client.ts';
import { opencodeServer } from './server.ts';
import { resumeThread, startThread, type ApprovalResult, type OpencodeThread, type OpencodeThreadEvent, type Tool } from './threads.ts';
import { OPENCODE_PREFIX } from './types.ts';
import { diffsOf, nativeCall, patchCards, shellFailed, todosOf, TURN_OPEN } from './history.ts';

const QUEUE_MAX = 20;
// Streamed message ids and called tools, each kept only while their item is open.
const ITEMS_MAX = 50;
const REASONING_MAX = 2000;
// Session-wide "always" grants; OpenCode's own always would save the rule past this session.
const GRANTS_MAX = 100;
const CATALOG_MS = 60_000;
const OWN_SERVERS: Record<string, string> = { app: 'questions, tables, plans and agents', visual: 'pictures', replay: 'replays', 'agents-panel': 'progress updates' };
// Marks sessions this app created, so the session list shows only those.
export const MAIN_MARK = { tarcsweb: 'main' };

type ToolEvent = Extract<ServerEvent, { type: 'tool' }>;
type Msg = { id: string; text: string };
type Obj = Record<string, unknown>;
export type TokenCounts = { input: number; cachedInput: number; cacheWriteInput: number; output: number; reasoning: number };

// The MCP name prefix of a tab: short enough that `<prefix>_<server>_<tool>` stays under OpenCode's 64-character tool names.
export const mcpKey = (tabId: string) => `tarcsweb_${createHash('sha256').update(tabId).digest('hex').slice(0, 10)}`;

// What the driver needs from its Session; the log, panel, ChangeLog and chapters stay there.
export type OpencodeHost = {
  cwd: string;
  tabId: string;
  model: () => string;
  effort: () => Effort;
  mode: () => Mode;
  // The saved OpenCode session to resume; started reports the one a new thread made.
  savedId: () => string | null;
  started: (id: string) => void;
  // The tab asked for OpenCode's default model; this is the one it got.
  resolved: (model: string) => void;
  push: (e: ServerEvent) => void;
  text: (id: string, delta: string) => void;
  activity: (text: string) => void;
  tool: (e: ToolEvent) => void;
  delivered: (id: string) => void;
  notSent: (ids: string[], why: string) => void;
  turnStarted: () => void;
  turnEnded: (ok: boolean, subtype: string, text: { id: string; text: string } | null, ms: number | null, more: boolean) => void;
  edited: (path: string, before: string | null, after: string | null, note: string | null, add: number, rm: number) => void;
  plan: (steps: { step: string; status: string }[]) => void;
  context: (counts: TokenCounts, max: number | null) => void;
  total: (tokens: number, cost: number | null) => void;
  compacting: (on: boolean) => void;
  ask: (a: CodexAsk) => Promise<ApprovalDecision>;
  // A simple OpenCode form as a question card; null when the user did not answer.
  form: (id: string, round: RoundInput, signal: AbortSignal) => Promise<RoundSent | null>;
  failedCommand: (id: string, command: string, output: string) => void;
  // The tab's grant on the app's MCP endpoint.
  tools: () => { urls: Record<string, string>; authorization: string };
  ownTool: (id: string, name: string, input: unknown) => void;
  ownResult: (id: string, content: unknown, isError: boolean) => void;
  instructions: () => string;
  // The per-turn reminder and one-off notes (clock, stretches opened).
  turnNote: () => string;
  replay: () => Promise<string | null>;
  replayDelivered: () => void;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const capAdd = <K, V>(m: Map<K, V>, k: K, v: V) => {
  m.set(k, v);
  if (m.size > ITEMS_MAX) m.delete(m.keys().next().value!);
};
const changeOf = (f: FileDiff): FileUpdateChange => ({ path: f.file, kind: f.status === 'added' ? { type: 'add' } : f.status === 'deleted' ? { type: 'delete' } : { type: 'update', move_path: null }, diff: f.patch });
const wildcard = (pattern: string) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
const lineCount = (s: string) => (s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0);

// Also used by reopened history, so the wording stays the same in both.
export const errorMessage = (error: string) => `OpenCode: ${oneLine(error, 400)}`;

// An OpenCode session as a tab's main agent: turns, steering, the event mapping to the client protocol, approvals and forms.
export class OpencodeMain {
  private host: OpencodeHost;
  private thread: OpencodeThread | null = null;
  private opening: Promise<OpencodeThread> | null = null;
  private unloading: Promise<void> | null = null;
  private unsub: () => void = () => {};
  private active = false;
  private stopAsked = false;
  private startedAt = 0;
  private queue: Msg[] = [];
  private steering = false;
  private ended: (() => void) | null = null;
  private runs = 0;
  private closed = false;
  private name: string | null = null;
  private sentPrompt: string | null = null;
  private compactingNow = false;
  private streamed = new Map<string, true>();
  private called = new Map<string, true>();
  private reasoning = '';
  private reasoningId = '';
  private lastText: { id: string; text: string } | null = null;
  private grants: { action: string; re: RegExp }[] = [];
  private catalog: { at: number; list: ModelInfo[] } | null = null;
  private mcpFailed = new Set<string>();
  private mcpCheck: ReturnType<typeof setTimeout> | null = null;

  constructor(host: OpencodeHost) {
    this.host = host;
  }

  get busy() {
    return this.active;
  }

  get loaded() {
    return !!this.thread && !this.thread.closed;
  }

  async send(id: string, text: string, files: Upload[], segs?: Seg[] | null) {
    let body: string;
    try {
      body = segs ? (await Promise.all(segs.map((s) => ('file' in s ? this.fileNote(s.file) : s.text)))).join('\n\n') : [...(await Promise.all(files.map((f) => this.fileNote(f)))), text].filter((t) => t.trim()).join('\n\n');
    } catch (e) {
      return this.host.notSent([id], `The attachment could not be saved (${errText(e)}).`);
    }
    if (this.closed) return;
    const msg = { id, text: body };
    if (!this.active) return void this.run([msg]);
    if (this.enqueue(msg)) await this.flushSteer();
  }

  // Frees an idle thread and its MCP registration; the next send resumes the session by id.
  unload() {
    const t = this.thread;
    if (this.active || this.opening || !t || t.closed) return;
    this.unsub();
    this.thread = null;
    this.unloading = t.close().catch(() => {}).finally(() => (this.unloading = null));
  }

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

  // Applied to an open thread at once; a closed one gets the mode at its next turn. Resolves to why it failed, or null.
  async setMode(mode: Mode): Promise<string | null> {
    const t = this.thread;
    if (!t || t.closed || t.mode === mode) return null;
    try {
      await t.setMode(mode);
      return null;
    } catch (e) {
      return errText(e);
    }
  }

  setName(name: string) {
    this.name = name;
    const id = this.thread?.id ?? this.host.savedId();
    if (id) void opencode.updateSession(id, { title: name }).catch((e: unknown) => console.warn(`[opencode] rename failed: ${errText(e)}`));
  }

  async close() {
    this.closed = true;
    this.queue = [];
    if (this.mcpCheck) clearTimeout(this.mcpCheck);
    const t = this.thread;
    if (t?.turnId) await t.interrupt().catch(() => {});
    await t?.close().catch(() => {});
  }

  // Text files go inline; images and PDFs are saved for the agent to open with its file tools.
  private async fileNote(f: Upload) {
    if (f.kind === 'text') return `File ${f.name}:\n\n${f.data}`;
    const name = f.kind === 'image' ? `image.${f.mime === 'image/jpeg' ? 'jpg' : f.mime.slice(6)}` : basename(f.name).replace(/[^\w.-]+/g, '_');
    const path = await saveUpload(`opencode-${this.host.tabId}`, name, f.data);
    return f.kind === 'image' ? `The user attached the image ${oneLine(f.name, 120)}, saved at ${path}. Open it with your file-reading tool.` : pdfNote(path);
  }

  private enqueue(msg: Msg) {
    if (this.queue.length >= QUEUE_MAX) {
      this.host.notSent([msg.id], `${QUEUE_MAX} messages are already waiting for OpenCode.`);
      return false;
    }
    this.queue.push(msg);
    return true;
  }

  private async steer(msg: Msg) {
    if (this.compactingNow || !this.thread?.turnId) return false;
    try {
      if (!(await this.thread.steer(msg.text))) return false;
    } catch {
      return false;
    }
    this.host.delivered(msg.id);
    return true;
  }

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

  private afterSteer(fn: () => void) {
    if (this.steering) this.ended ??= fn;
    else fn();
  }

  private async run(msgs: Msg[]) {
    const gen = ++this.runs;
    this.active = true;
    this.stopAsked = false;
    this.startedAt = Date.now();
    this.host.turnStarted();
    for (const m of msgs) this.host.delivered(m.id);
    try {
      const thread = await this.ensureThread();
      await this.sync(thread);
      const replay = await this.host.replay();
      const text = `${replay ? `${replay}\n\n` : ''}${msgs.map((m) => m.text).join('\n\n')}\n\n${TURN_OPEN}\n${this.host.turnNote()}\n</tarcsweb_turn>`;
      await thread.startTurn(text);
      if (replay) this.host.replayDelivered();
    } catch (e) {
      this.afterSteer(() => this.runFailed(e, gen));
    }
  }

  private runFailed(e: unknown, gen: number) {
    if (!this.active || gen !== this.runs) return;
    this.active = false;
    this.host.push({ type: 'error', message: errText(e) });
    this.host.turnEnded(false, 'error_during_execution', null, null, false);
    const left = this.queue.splice(0);
    if (left.length) this.host.notSent(left.map((m) => m.id), 'OpenCode could not start the turn, so the messages waiting for it were dropped.');
  }

  // The catalog decides: an unknown model fails with a clear message, a variant the model lacks falls back to its default.
  private async modelAndEffort() {
    const location = { directory: this.host.cwd };
    if (!this.catalog || Date.now() - this.catalog.at > CATALOG_MS) this.catalog = { at: Date.now(), list: (await opencode.models(location)).data };
    let model = this.host.model();
    if (model === OPENCODE_PREFIX) {
      const d = (await opencode.defaultModel(location)).data;
      if (!d) throw new Error('OpenCode has no default model. Connect a provider with `opencode auth login`, or pick a model in the model menu.');
      model = `${OPENCODE_PREFIX}${d.providerID}/${d.id}`;
      this.host.resolved(model);
    }
    const m = this.catalog.list.find((x) => `${OPENCODE_PREFIX}${x.providerID}/${x.id}` === model);
    if (!m) throw new Error(`OpenCode has no model named ${model.slice(OPENCODE_PREFIX.length)}. Pick another one in the model menu.`);
    const variants = m.variants.map((v) => v.id);
    const effort: string = this.host.effort();
    return { model, effort: variants.includes(effort) ? effort : variants.find((v) => v === 'medium' || v === 'high') ?? variants[0] };
  }

  // Model, effort, mode and the app's instructions as the tab has them now; OpenCode keeps each on the session.
  private async sync(thread: OpencodeThread) {
    const { model, effort } = await this.modelAndEffort();
    if (thread.model !== model || (thread.effort ?? undefined) !== effort) await thread.setModel(model, effort);
    if (thread.mode !== this.host.mode()) await thread.setMode(this.host.mode());
    const prompt = this.host.instructions();
    if (prompt !== this.sentPrompt) {
      await opencode.putInstruction(thread.id, 'tarcsweb', prompt);
      this.sentPrompt = prompt;
    }
  }

  private async ensureThread() {
    if (this.thread && !this.thread.closed) return this.thread;
    this.opening ??= this.open().finally(() => (this.opening = null));
    return this.opening;
  }

  private async open() {
    if (this.unloading) await this.unloading;
    try {
      await opencodeServer.start();
    } catch (e) {
      throw new Error(`OpenCode could not start: ${oneLine(errText(e), 300)}. Check it in Settings > Account.`);
    }
    const { model, effort } = await this.modelAndEffort();
    const key = mcpKey(this.host.tabId);
    const grant = this.host.tools();
    const mcp = { name: key, url: '', authorization: grant.authorization, servers: Object.entries(grant.urls).map(([s, url]) => ({ name: `${key}_${s}`, url })) };
    const prompt = this.host.instructions();
    const opts = { cwd: this.host.cwd, model, effort, mode: this.host.mode(), instructions: prompt, mcp, subagents: false, metadata: MAIN_MARK };
    const saved = this.host.savedId();
    // Sending to an archived session brings it back, as on the other providers.
    if (saved) await opencode.updateSession(saved, { archived: false }).catch(() => {});
    const thread = saved ? await resumeThread(saved, opts) : await startThread(opts);
    if (this.closed) {
      void thread.close();
      throw new Error('The session closed');
    }
    this.thread = thread;
    this.sentPrompt = prompt;
    if (thread.id !== saved) this.mcpFailed.clear();
    this.unsub = thread.subscribe((e) => this.on(e));
    thread.onApproval((r) => this.approve(r));
    thread.onForm((f) => this.form(f));
    this.host.started(thread.id);
    if (this.name && !saved) void opencode.updateSession(thread.id, { title: this.name }).catch(() => {});
    this.checkMcp();
    return thread;
  }

  private on(e: OpencodeThreadEvent) {
    // Native subagents are denied, so events of other sessions are only noise here.
    if (this.thread && e.sessionID !== this.thread.id && e.type !== 'closed') return;
    switch (e.type) {
      case 'turn-started':
        // A turn OpenCode starts itself, such as a background command reporting back.
        if (!this.active) {
          this.active = true;
          this.startedAt = Date.now();
        }
        this.host.turnStarted();
        if (this.stopAsked) void this.thread?.interrupt().catch(() => {});
        else void this.flushSteer();
        return;
      case 'message-delta':
        capAdd(this.streamed, e.itemId, true);
        this.host.text(`oc:${e.itemId}`, e.delta);
        return;
      case 'message-final':
        if (!this.streamed.has(e.itemId) && e.text) this.host.text(`oc:${e.itemId}`, e.text);
        this.streamed.delete(e.itemId);
        if (e.text) this.lastText = { id: `oc:${e.itemId}`, text: e.text };
        return;
      case 'reasoning-delta': {
        if (e.itemId !== this.reasoningId) {
          this.reasoningId = e.itemId;
          this.reasoning = '';
        }
        this.reasoning = (this.reasoning + e.delta).slice(-REASONING_MAX);
        const head = [...this.reasoning.matchAll(/\*\*(.+?)\*\*/g)].pop()?.[1];
        this.host.activity(head ? oneLine(head, 80) : 'Thinking');
        return;
      }
      case 'tool-start':
      case 'tool-update':
      case 'tool-end':
        return this.tool(e.type, e.tool);
      case 'plan':
        return this.host.plan(todosOf(e.todos).map((t) => ({ step: t.content, status: t.status === 'in_progress' ? 'inProgress' : t.status })));
      case 'tokens': {
        const t = e.usage;
        const cache = obj(t.cache);
        const n = (v: unknown) => (typeof v === 'number' ? v : 0);
        const counts = { input: n(t.input), cachedInput: n(cache.read), cacheWriteInput: n(cache.write), output: n(t.output), reasoning: n(t.reasoning) };
        if (e.cumulative) this.host.total(counts.input + counts.cachedInput + counts.cacheWriteInput + counts.output + counts.reasoning, e.cost ?? null);
        else this.host.context(counts, e.contextWindow);
        return;
      }
      case 'raw':
        return this.raw(e.event.type, e.event.data);
      case 'error':
        this.host.push({ type: 'error', message: errorMessage(e.error) });
        return;
      case 'turn-ended':
        return this.afterSteer(() => this.turnDone(e.status, e.error));
      case 'closed':
        return this.lost();
    }
  }

  private raw(type: string, data: Obj) {
    if (type === 'session.compaction.started') {
      this.compactingNow = true;
      return this.host.compacting(true);
    }
    if (type === 'session.compaction.ended' || type === 'session.compaction.failed') {
      this.compactingNow = false;
      this.host.compacting(false);
      if (type === 'session.compaction.failed') this.host.push({ type: 'error', message: `OpenCode could not compact the conversation: ${oneLine(str(obj(data.error).message) || 'unknown error', 300)}` });
      return void this.flushSteer();
    }
    if (type === 'session.retry.scheduled') return this.host.activity(`Retrying: ${oneLine(str(obj(data.error).message) || 'provider error', 80)}`);
    if (type === 'mcp.status.changed' && str(data.server).startsWith(`${mcpKey(this.host.tabId)}_`)) this.checkMcp();
  }

  // One of the app's MCP servers failed to connect, so its tools are missing from this session.
  private checkMcp() {
    if (this.mcpCheck) clearTimeout(this.mcpCheck);
    this.mcpCheck = setTimeout(() => {
      this.mcpCheck = null;
      const key = `${mcpKey(this.host.tabId)}_`;
      void opencode.mcp({ directory: this.host.cwd }).then(({ data }) => {
        for (const s of data) {
          const name = s.name.startsWith(key) ? s.name.slice(key.length) : '';
          if (s.status.status !== 'failed' || !TOOL_SERVERS.includes(name) || this.mcpFailed.has(name) || this.closed) continue;
          this.mcpFailed.add(name);
          this.host.push({ type: 'error', message: `The app's ${name} tools (${OWN_SERVERS[name] ?? 'visuals, questions, progress'}) are unavailable on this tab. OpenCode could not start them${s.status.error ? `: ${oneLine(s.status.error, 200)}` : '.'}` });
        }
      }, () => {});
    }, 1500);
    this.mcpCheck.unref?.();
  }

  private tool(kind: 'tool-start' | 'tool-update' | 'tool-end', t: Tool) {
    const id = `oc:${t.id}`;
    if (t.name === 'patch') {
      if (kind === 'tool-start') this.host.activity('Editing files');
      if (kind === 'tool-end') void this.patchDone(id, t);
      return;
    }
    const call = nativeCall(t.name, obj(t.input));
    if (!this.called.has(id)) {
      // The input is still streaming; the card opens once OpenCode calls the tool with all of it.
      if (t.status === 'streaming') return;
      capAdd(this.called, id, true);
      this.host.ownTool(id, call.name, call.input);
    }
    if (kind !== 'tool-end') return;
    this.called.delete(id);
    const failed = t.status === 'failed' || (call.name === 'Bash' && shellFailed(t.metadata));
    const content = t.output ?? (t.error ? [{ type: 'text', text: t.error }] : []);
    this.host.ownResult(id, content, failed);
    if (call.name === 'Bash' && failed && !this.stopAsked) this.host.failedCommand(id, str(call.input.command), resultText(content) || t.error || '');
    if (t.status === 'completed' && (t.name === 'edit' || t.name === 'write')) void this.recordEdits(t).catch((e: unknown) => console.warn('[opencode] file change not recorded', e));
  }

  // A patch shows one diff card per file it changed, built when it ends.
  private async patchDone(id: string, t: Tool) {
    const files = diffsOf(t.metadata);
    const cards = patchCards(this.host.cwd, id, files);
    const error = t.status === 'completed' ? null : oneLine(t.error ?? 'Failed', 200);
    if (!cards.length) cards.push({ type: 'tool', id, name: 'Edit', verb: 'edit', summary: 'a patch' });
    for (const c of cards) {
      this.host.tool(c);
      this.host.push({ type: 'tool-result', id: c.id, error });
    }
    if (!error) await this.recordEdits(t).catch((e: unknown) => console.warn('[opencode] file change not recorded', e));
  }

  // Both texts of each applied change, for the ChangeLog: from OpenCode's patches, else from a write's content.
  private async recordEdits(t: Tool) {
    const files = diffsOf(t.metadata);
    for (const f of files) {
      const c = await changeTexts(this.host.cwd, changeOf(f));
      this.host.edited(c.dest, c.before, c.after, c.note, c.add, c.rm);
    }
    const input = obj(t.input);
    if (files.length || t.name !== 'write' || typeof input.content !== 'string' || !str(input.path)) return;
    const created = /^Created/.test(resultText(t.output));
    const after = input.content;
    this.host.edited(resolve(this.host.cwd, str(input.path)), created ? '' : null, after, created ? null : 'Diff not available', lineCount(after), 0);
  }

  private turnDone(status: 'succeeded' | 'failed' | 'interrupted', error: string | null) {
    if (!this.active) return;
    this.active = false;
    if (status === 'failed') this.host.push({ type: 'error', message: errorMessage(error ?? 'the turn failed') });
    const text = this.lastText;
    this.lastText = null;
    this.reasoning = '';
    if (this.compactingNow) {
      this.compactingNow = false;
      this.host.compacting(false);
    }
    const next = this.queue.splice(0);
    this.host.turnEnded(status === 'succeeded', status, text, this.startedAt ? Date.now() - this.startedAt : null, next.length > 0);
    if (next.length && !this.closed) void this.run(next);
  }

  // The thread went away under a running turn; the next send resumes the session by id.
  private lost() {
    this.unsub();
    this.thread = null;
    this.afterSteer(() => {
      if (this.closed || !this.active) return;
      this.active = false;
      this.host.push({ type: 'error', message: 'OpenCode stopped: the session closed.' });
      const next = this.queue.splice(0);
      this.host.turnEnded(false, 'error_during_execution', null, null, next.length > 0);
      if (next.length) void this.run(next);
    });
  }

  private granted(r: PermissionRequest) {
    return r.resources.length > 0 && r.resources.every((res) => this.grants.some((g) => g.action === r.action && g.re.test(res)));
  }

  private grant(r: PermissionRequest) {
    for (const p of r.save?.length ? r.save : r.resources) this.grants.push({ action: r.action, re: wildcard(p) });
    if (this.grants.length > GRANTS_MAX) this.grants.splice(0, this.grants.length - GRANTS_MAX);
  }

  private async approve(r: PermissionRequest & { signal: AbortSignal }): Promise<ApprovalResult> {
    if (this.granted(r)) return 'once';
    const cwd = this.host.cwd;
    const meta = obj(r.metadata);
    const title = `OpenCode${r.message ? ` — ${oneLine(r.message, 160)}` : ''}`;
    let a: CodexAsk;
    if (r.action === 'shell') {
      const command = str(meta.command) || r.resources.join(' ') || 'a command';
      a = {
        agentId: 'main', tool: 'Bash', summary: oneLine(relText(cwd, command), 300), title, detail: null, signal: r.signal,
        command: cardCommand(cwd, 'Bash', { command }), facts: { tool: 'Bash', command, cwd: str(meta.workdir) || cwd },
      };
    } else if (r.action === 'edit') {
      const files = diffsOf(meta);
      const paths = (files.length ? files.map((f) => f.file) : r.resources).map((p) => resolve(cwd, p));
      const tool = files.length && files.every((f) => f.status === 'added') ? 'Write' : 'Edit';
      const detail = files.length === 1 ? changeDetail(cwd, changeOf(files[0])) : null;
      a = { agentId: 'main', tool, summary: paths.map((p) => displayPath(cwd, p)).join(', ') || 'files', title, detail, signal: r.signal, facts: { tool, paths } };
    } else {
      const what = r.action === 'external_directory' ? 'Access outside this folder' : `${r.action} access`;
      a = { agentId: 'main', tool: 'Permissions', summary: `${what}: ${oneLine(r.resources.join(', ') || 'unspecified', 200)}`, title, detail: null, signal: r.signal };
    }
    const d = await this.host.ask(a);
    if (d === 'decline') return { decision: 'reject', message: 'The user declined this action. Do not retry it; continue without it or ask the user.' };
    if (d === 'cancel') return { decision: 'reject', message: 'The approval was cancelled before the user answered. Do not retry it unless the user asks.' };
    if (d === 'acceptForSession') this.grant(r);
    return 'once';
  }

  // String and multiselect fields as one question card: up to four options pick one, anything else is typed.
  private async form(f: FormInfo & { signal: AbortSignal }): Promise<FormAnswer | null> {
    if (f.fields.length > 5) {
      this.host.push({ type: 'error', message: `OpenCode asked a form with ${f.fields.length} fields; question cards hold 5 at most, so it was dismissed.` });
      return null;
    }
    const fields = f.fields.map((x) => {
      const options = Array.isArray(x.options) ? x.options : [];
      const choice = options.length >= 2 && options.length <= 4;
      const list = !choice && options.length ? ` Options: ${options.map((o) => o.label).join(', ')}${x.type === 'multiselect' ? ' (comma-separated)' : ''}.` : '';
      const setup = `${str(x.description)}${list}`.trim();
      return {
        x, options,
        q: { title: oneLine(str(x.title) || x.key, 200), ...(setup ? { setup } : {}), kind: choice ? 'choice' : 'text', options: choice ? options.map((o) => ({ label: o.label })) : [] },
      };
    });
    const round: RoundInput = { title: oneLine(f.title || 'OpenCode asks', 80), questions: fields.map((x) => x.q) };
    const sent = await this.host.form(`oc:form:${f.id}`, round, f.signal);
    if (!sent) return null;
    const answer: FormAnswer = {};
    fields.forEach(({ x, options }, i) => {
      const p = sent.picks[i];
      if (!p) return;
      const picked = p.option !== null ? options[p.option]?.value : undefined;
      const typed = p.note.trim();
      if (x.type === 'multiselect') {
        const values = picked ? [picked] : typed.split(',').map((s) => s.trim()).filter(Boolean).map((s) => options.find((o) => o.label === s)?.value ?? s);
        if (values.length) answer[x.key] = values;
      } else if (picked ?? typed) answer[x.key] = picked ?? typed;
    });
    return Object.keys(answer).length ? answer : null;
  }
}
