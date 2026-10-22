import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRow, AgentState, AgentText, FileTouch, Panel, ProcRow, ProcState, Steps, Wake, WatchSub } from './protocol.ts';
import { tuning } from './profile.ts';
import { displayPath, oneLine } from './text.ts';
import { PLUMBING, describeTool } from './tools.ts';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const PROGRESS_TOOL = 'mcp__agents-panel__progress';
const TEXT_MAX = 6000;
const TASK_MAX = 4000;
const RESULT_MAX = 12000;
const FOLLOW_MAX = 20;
const KEEP = 30;
const SAID_MAX = 400;
// Files a subagent row carries; older ones are only counted.
const ROW_FILES = 100;
// Quick foreground commands stay out of the Processes list; past this they show there too.
const FG_SHOW_MS = 10_000;
// A row's lastAt moves in 5 s steps, so a streaming agent does not patch its row on every chunk.
export const lastStamp = (t: number) => t - (t % 5000);
// Used until a result reports modelUsage.contextWindow; the 5.x CLI reported 1M for haiku 5.5 too.
const WINDOWS: [RegExp, number][] = [[/opus|sonnet|haiku|fable/, 1_000_000]];

// Agent rows per workflow run (later ones are only counted), journal bytes read per tick, prompt bytes read per agent.
const WF_AGENTS_MAX = 40;
const JOURNAL_CHUNK = 4 << 20;
const PROMPT_HEAD = 256 << 10;
// Workflow transcript folders seen in tool results before their task_started, by task id.
const WF_DIRS_MAX = 20;

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };

// One agent inside a workflow run, read from its journal.jsonl; task stays null until its detail is asked for.
type WfAgent = {
  id: string; agentId: string; name: string; phase: string; state: AgentState; startedAt: number; endedAt: number | null;
  result: string | null; said: string; task: string | null; rev: number;
};
// dir: the run's transcript folder (from the Workflow tool result); offset/rest: journal bytes read and a partial last line.
// kids: capped at WF_AGENTS_MAX; dropped counts the agents past the cap.
type Workflow = { dir: string | null; offset: number; rest: Buffer; kids: Map<string, WfAgent>; dropped: number; timer: ReturnType<typeof setTimeout> | null };

// A tool_result's text, which is a string or a list of text blocks.
function fullText(content: unknown) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b as Block).text ?? '').join('\n') : '';
  return text.replace(/<\/?tool_use_error>/g, '').trim();
}

function resultLine(content: unknown) {
  return oneLine(fullText(content).split('\n')[0] ?? '', 160);
}
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
// log: step names in the order reported, last = current; capped at LOG_MAX.
type Progress = { task: string; total: number; done: number; step: string; startAt: number; lastAt: number; log: string[] };
const LOG_MAX = 50;

type Agent = {
  id: string;
  taskId: string | null;
  main: boolean;
  name: string;
  modelId: string | null;
  alias: string | null;
  effort: string | null;
  state: AgentState;
  startedAt: number;
  endedAt: number | null;
  background: boolean;
  tokens: number | null;
  progress: Progress | null;
  summary: string | null;
  // task_progress description, e.g. "Reading hello.txt".
  activity: string | null;
  lastTool: string;
  files: Map<string, FileTouch>;
  text: string;
  pending: number;
  // The prompt it was given and its final report, for the full screen detail.
  task: string;
  followUps: { at: number; text: string }[];
  result: string | null;
  // Bumped when text, task, result or follow-ups change.
  rev: number;
  workflow: Workflow | null;
  // Last sign of life, tool calls made, whether the newest call is Bash, and why it failed.
  lastAt: number;
  toolUses: number;
  shell: boolean;
  error: string | null;
  // Run by claude_agent outside the main query; it keeps no transcript.
  adopted: boolean;
};

type Proc = ProcRow & { outputFile: string | null; inRoster: boolean };

// Agents that run outside the CLI (Codex threads), merged into the same panel.
export type ExternalAgents = {
  rows(): AgentRow[]; running(): boolean; detail(id: string): AgentText | null; nameOf(id: string): string | null;
  activity(id: string, rev: number): WatchSub | null;
};

// edited/read report each file touch, so the session can credit it to the current chapter.
export type Ctx = {
  model: () => string; effort: () => string; changed: () => void;
  edited?: (path: string, add: number, rm: number) => void; read?: (path: string) => void;
};

// "claude-haiku-5-5-20261001" -> "haiku 5.5"; aliases stay as they are.
export function modelLabel(id: string) {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : id.replace(/\[.*\]$/, '');
}

const lineList = (s: string) => (s ? s.replace(/\n$/, '').split('\n') : []);

// Lines added and removed, ignoring the unchanged lines at both ends.
function lineDelta(before: string, after: string): [number, number] {
  const a = lineList(before);
  const b = lineList(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [b.length - start - end, a.length - start - end];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export { displayPath };

// What a successful file tool call did to its file, or null for other tools.
export function fileDelta(name: string, input: Record<string, unknown>): { path: string; mode: FileTouch['mode']; add: number; rm: number } | null {
  const path = str(input.file_path) || str(input.notebook_path);
  if (!path) return null;
  let add = 0;
  let rm = 0;
  if (name === 'Read') return { path, mode: 'read', add, rm };
  if (name === 'Edit') [add, rm] = lineDelta(str(input.old_string), str(input.new_string));
  else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const e of input.edits as Record<string, unknown>[]) {
      const [x, y] = lineDelta(str(e.old_string), str(e.new_string));
      add += x;
      rm += y;
    }
  } else if (name === 'Write') add = lineList(str(input.content)).length;
  else if (name === 'NotebookEdit') {
    if (input.edit_mode === 'delete') rm = 1;
    else add = lineList(str(input.new_source)).length;
  } else return null;
  return { path, mode: 'edited', add, rm };
}

export class AgentTracker {
  private cwd: string;
  private ctx: Ctx;
  private main: Agent | null = null;
  private agents = new Map<string, Agent>();
  private procs = new Map<string, Proc>();
  private external: ExternalAgents | null = null;
  // SendMessage call id -> the agent it targets; a finished agent it resumes keeps its own row.
  private resumes = new Map<string, string>();
  private alias = new Map<string, string>();
  // Foreground shell tasks, kept in case they move to the background later.
  private foreground = new Map<string, Proc>();
  private byTask = new Map<string, string>();
  // tool_use id -> agent row id that made the call, for permissions.
  private owner = new Map<string, string>();
  private bash = new Map<string, { command: string; label: string | null }>();
  // File tools wait for their result, so a denied or failed edit is not counted.
  private fileCalls = new Map<string, { agent: Agent; name: string; input: Record<string, unknown> }>();
  private windows = new Map<string, number>();
  private streamMsg = new Map<string, string>();
  private streamed = new Set<string>();
  private interrupted = false;
  // snapshot() runs on every map and panel tick; the last line is cut once per text change.
  private said = new WeakMap<Agent, { rev: number; said: string }>();
  private wfDirs = new Map<string, string>();

  constructor(cwd: string, ctx: Ctx) {
    this.cwd = cwd;
    this.ctx = ctx;
  }

  attach(external: ExternalAgents) {
    this.external = external;
  }

  private newAgent(id: string, main: boolean, name: string): Agent {
    return {
      id, taskId: null, main, name, modelId: null, alias: null, effort: null, state: 'running', startedAt: Date.now(), endedAt: null,
      background: false, tokens: null, progress: null, summary: null, activity: null, lastTool: '', files: new Map(), text: '', pending: 0, task: '', followUps: [], result: null, rev: 0, workflow: null,
      lastAt: Date.now(), toolUses: 0, shell: false, error: null, adopted: false,
    };
  }

  private alive(a: Agent | null | undefined) {
    if (a) a.lastAt = Date.now();
  }

  statusChanged(working: boolean) {
    if (working && this.main?.state !== 'running') this.turnStart();
  }

  turnStart() {
    this.main ??= this.newAgent('main', true, 'main');
    this.main.startedAt = Date.now();
    this.main.endedAt = null;
    this.main.state = 'running';
    this.interrupted = false;
    this.ctx.changed();
  }

  turnEnd(ok: boolean, modelUsage: Record<string, { contextWindow?: number }> | undefined) {
    for (const [model, u] of Object.entries(modelUsage ?? {})) if (u.contextWindow) this.windows.set(model, u.contextWindow);
    if (this.main) {
      this.main.endedAt = Date.now();
      this.main.state = this.interrupted ? 'stopped' : ok ? 'done' : 'failed';
    }
    this.ctx.changed();
  }

  markInterrupted() {
    this.interrupted = true;
  }

  // A Codex main thread reports its plan, usage and file edits directly instead of through tool calls.
  mainPlan(task: string, steps: { step: string; status: string }[]) {
    if (!this.main) return;
    const done = steps.filter((s) => s.status === 'completed').length;
    const cur = steps.find((s) => s.status === 'inProgress') ?? steps.find((s) => s.status === 'pending');
    const now = Date.now();
    const p = this.main.progress;
    const restart = !p || done < p.done || steps.length === 0;
    this.main.progress = {
      task: task || p?.task || '', total: steps.length, done, step: cur?.step ?? '',
      log: [...steps.filter((s) => s.status === 'completed').map((s) => s.step), ...(cur ? [cur.step] : [])].slice(-LOG_MAX),
      startAt: restart ? now : p.startAt, lastAt: restart || done !== p.done ? now : p.lastAt,
    };
    this.ctx.changed();
  }

  mainUsage(tokens: number, window: number | null) {
    if (!this.main) return;
    this.main.tokens = tokens;
    if (window) this.windows.set(this.ctx.model(), window);
    this.ctx.changed();
  }

  mainFile(path: string, add: number, rm: number) {
    if (!this.main) return;
    this.ctx.edited?.(this.display(path), add, rm);
    this.addFile(this.main, path, 'edited', add, rm);
    this.ctx.changed();
  }

  // The CLI process is gone, and every task it ran with it.
  processEnded() {
    const now = Date.now();
    for (const a of [...this.agents.values(), ...(this.main ? [this.main] : [])]) if (a.state === 'running') Object.assign(a, { state: 'stopped', endedAt: now });
    for (const p of this.procs.values()) if (p.state === 'running') Object.assign(p, { state: 'stopped', endedAt: now });
    this.foreground.clear();
    for (const p of this.procs.values()) p.inRoster = false;
    this.ctx.changed();
  }

  hasRunning() {
    return this.agentsRunning() || [...this.procs.values()].some((p) => p.state === 'running');
  }

  // A dev server left running is not an agent at work, so the dock's background glyph ignores processes.
  agentsRunning() {
    return [...this.agents.values()].some((a) => a.state === 'running') || !!this.external?.running();
  }

  // row names the asking row outright (an adopted run's ask can come before its tool_use is fed).
  permission(toolUseId: string, agentId: string | undefined, on: boolean, row?: string) {
    const byAgent = agentId ? this.byTask.get(agentId) : undefined;
    const id = row ?? this.owner.get(toolUseId) ?? byAgent ?? 'main';
    const a = id === 'main' ? this.main : this.agentById(id);
    if (!a) return;
    a.pending = Math.max(0, a.pending + (on ? 1 : -1));
    this.ctx.changed();
  }

  // What a finished task was called, for the update header of the turn it wakes.
  wakeOf(taskId: string): Wake | null {
    const a = this.agentByTask(taskId);
    if (a) return { via: 'agent', name: oneLine(a.name, 80) };
    const p = this.procs.get(taskId);
    return p ? { via: 'command', name: oneLine(p.label || p.command, 80) } : null;
  }

  taskOf(id: string) {
    return this.procs.get(id) ?? this.foreground.get(id) ?? null;
  }

  // A hook's agent_id is the subagent's task id; this gives its panel row id.
  rowOfTask(taskId: string) {
    return this.byTask.get(taskId) ?? null;
  }

  nameOf(rowId: string) {
    return this.agentById(rowId)?.name ?? this.external?.nameOf(rowId) ?? null;
  }

  handle(m: SDKMessage) {
    switch (m.type) {
      case 'assistant':
        return this.onAssistant(m.parent_tool_use_id, m.message as unknown as { id: string; model?: string; content: Block[]; usage?: Usage });
      case 'user':
        return this.onToolResults(m.message.content, m.tool_use_result);
      case 'stream_event': {
        const parent = m.parent_tool_use_id;
        if (!parent) return;
        const ev = m.event;
        if (ev.type === 'message_start') this.streamMsg.set(parent, ev.message.id);
        else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          const a = this.agentById(parent);
          const msgId = this.streamMsg.get(parent);
          if (!a || !msgId) return;
          this.alive(a);
          this.streamed.add(msgId);
          this.appendText(a, ev.delta.text);
          this.ctx.changed();
        }
        return;
      }
      case 'system':
        // A finished background task starts a turn of its own, with no send and no status change.
        if (m.subtype === 'init' && this.main && this.main.state !== 'running') this.turnStart();
        return this.onSystem(m);
    }
  }

  private agentFor(parent: string | null) {
    return parent ? this.agentById(parent) : this.main;
  }

  private appendText(a: Agent, text: string) {
    a.text = (a.text + text).slice(-TEXT_MAX);
    a.rev++;
  }

  private onAssistant(parent: string | null, msg: { id: string; model?: string; content: Block[]; usage?: Usage }) {
    const a = this.agentFor(parent);
    if (!a) return;
    this.alive(a);
    if (msg.model && !msg.model.startsWith('<')) a.modelId = msg.model;
    const u = msg.usage;
    if (u) {
      const total = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
      if (total) a.tokens = total;
    }
    for (const b of msg.content) {
      if (b.type === 'text' && b.text && !a.main && !this.streamed.has(msg.id)) this.appendText(a, (a.text ? '\n' : '') + b.text);
      if (b.type === 'tool_use' && b.id) this.onToolUse(a, b.id, b.name ?? '', (b.input ?? {}) as Record<string, unknown>);
    }
    this.ctx.changed();
  }

  private progressOf(a: Agent, input: Record<string, unknown>) {
    const total = num(input.total);
    const done = num(input.done);
    const task = str(input.task) || a.progress?.task || '';
    const now = Date.now();
    const p = a.progress;
    const restart = !p || done === 0 || done < p.done || (str(input.task) && input.task !== p.task);
    const step = str(input.step) || p?.step || '';
    const log = restart ? [] : p.log;
    if (step && (step !== log.at(-1) || (!restart && done > p.done))) log.push(step);
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    a.progress = {
      task, total, done, step, log: [...log],
      startAt: restart ? (done === 0 ? now : a.startedAt) : p.startAt,
      lastAt: restart || done !== p.done ? now : p.lastAt,
    };
  }

  // A Claude subagent run outside the main query (claude_agent on a Codex tab): a row fed by its own stream.
  // Its taskId is the row id, so the panel's stop and message buttons reach it.
  adopt(id: string, name: string, model: string, effort: string | null, task: string) {
    const a = this.newAgent(id, false, oneLine(name || 'Claude agent', 80));
    Object.assign(a, { taskId: id, alias: model, effort, task: task.slice(0, TASK_MAX), background: true, adopted: true });
    this.agents.set(id, a);
    this.byTask.set(id, id);
    this.trim(this.agents);
    this.ctx.changed();
  }

  // Its top-level messages read as if a parent Agent call made them; system messages (init, its own tasks) stay out.
  feed(id: string, m: SDKMessage) {
    if (m.type !== 'assistant' && m.type !== 'user' && m.type !== 'stream_event') return;
    this.handle(m.parent_tool_use_id ? m : ({ ...m, parent_tool_use_id: id } as SDKMessage));
  }

  // A follow-up starts the adopted row's next turn; null for a turn its process started on a message already counted.
  followUp(id: string, text: string | null) {
    const a = this.agents.get(id);
    if (!a) return;
    if (text !== null) a.followUps.push({ at: Date.now(), text: text.slice(0, TASK_MAX) });
    if (a.followUps.length > FOLLOW_MAX) a.followUps.shift();
    Object.assign(a, { state: 'running', endedAt: null, result: null, summary: null, activity: null, error: null, lastAt: Date.now(), rev: a.rev + 1 });
    this.ctx.changed();
  }

  // detach: its process is gone, so it takes no more messages.
  settle(id: string, state: 'done' | 'failed' | 'stopped', result: string | null, tokens: number | null, detach: boolean, error: string | null = null) {
    const a = this.agents.get(id);
    if (!a) return;
    if (result !== null) a.result = result.slice(0, RESULT_MAX);
    if (error && state === 'failed' && a.state === 'running') a.error = oneLine(error, 300);
    if (tokens) a.tokens = tokens;
    a.rev++;
    if (detach) a.taskId = null;
    this.end(a, state);
    this.ctx.changed();
  }

  // A Codex main thread's progress tool call; Claude's arrive through handle().
  mainProgress(input: Record<string, unknown>) {
    if (!this.main) return;
    this.progressOf(this.main, input);
    this.ctx.changed();
  }

  private onToolUse(a: Agent, id: string, name: string, input: Record<string, unknown>) {
    this.owner.set(id, a.id);
    if (name === PROGRESS_TOOL) return this.progressOf(a, input);
    if (!PLUMBING.has(name)) {
      a.lastTool = describeTool(this.cwd, name, input);
      a.toolUses++;
      a.shell = name === 'Bash';
    }
    if (name === 'Bash' && typeof input.command === 'string') this.bash.set(id, { command: input.command, label: oneLine(str(input.description), 80) || null });
    if (AGENT_TOOLS.has(name)) {
      const sub = this.newAgent(id, false, oneLine(str(input.description) || str(input.subagent_type) || 'agent', 80));
      sub.alias = str(input.model) || null;
      sub.effort = str(input.effort) || null;
      sub.task = str(input.prompt).slice(0, TASK_MAX);
      this.agents.set(id, sub);
      this.trim(this.agents);
      return;
    }
    if (name === 'SendMessage') {
      const to = str(input.to);
      const target = this.agentByTask(to) ?? [...this.agents.values()].find((x) => x.name === to);
      if (target) {
        target.followUps.push({ at: Date.now(), text: str(input.message).slice(0, TASK_MAX) });
        target.rev++;
        this.resumes.set(id, target.id);
      }
    }
    if (str(input.file_path) || str(input.notebook_path)) this.fileCalls.set(id, { agent: a, name, input });
  }

  private touchFiles(a: Agent, name: string, input: Record<string, unknown>) {
    const d = fileDelta(name, input);
    if (!d) return;
    const path = this.display(d.path);
    if (d.mode === 'read') this.ctx.read?.(path);
    else this.ctx.edited?.(path, d.add, d.rm);
    this.addFile(a, d.path, d.mode, d.add, d.rm);
  }

  private addFile(a: Agent, path: string, mode: FileTouch['mode'], add: number, rm: number) {
    // The main row ships no files (the conversation shows them), so it keeps none.
    if (a.main) return;
    const key = this.display(path);
    const prev = a.files.get(key);
    a.files.delete(key);
    a.files.set(key, {
      path: key, mode: prev?.mode === 'edited' ? 'edited' : mode, add: (prev?.add ?? 0) + add, rm: (prev?.rm ?? 0) + rm, at: Date.now(),
    });
  }

  private display(path: string) {
    return displayPath(this.cwd, path);
  }

  private onToolResults(content: unknown, toolUseResult: unknown) {
    if (!Array.isArray(content)) return;
    for (const b of content as Block[]) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      this.workflowLaunched(toolUseResult, b.content);
      const who = this.owner.get(b.tool_use_id);
      if (who && who !== 'main') {
        this.alive(this.agentById(who));
        this.ctx.changed();
      }
      const call = this.fileCalls.get(b.tool_use_id);
      if (call) {
        this.fileCalls.delete(b.tool_use_id);
        if (!b.is_error) this.touchFiles(call.agent, call.name, call.input);
        this.ctx.changed();
      }
      const a = this.agentById(b.tool_use_id);
      // A background agent's result is only the "running in the background" placeholder; a SendMessage result is only a receipt.
      if (!a || a.background || a.state !== 'running' || this.resumes.has(b.tool_use_id)) continue;
      if (b.is_error) {
        a.summary = resultLine(b.content) || a.summary;
        a.error = oneLine(fullText(b.content), 300) || 'The agent reported an error';
      }
      a.result = fullText(b.content).slice(0, RESULT_MAX) || a.result;
      a.rev++;
      this.end(a, b.is_error ? 'failed' : 'done');
    }
  }

  private end(x: { state: AgentState | ProcState; endedAt: number | null }, state: AgentState & ProcState) {
    if (x.state !== 'running' && x.state !== 'waiting') return;
    x.state = state;
    x.endedAt = Date.now();
    this.ctx.changed();
  }

  private onSystem(m: Extract<SDKMessage, { type: 'system' }>) {
    switch (m.subtype) {
      case 'task_started': {
        if (m.ambient) return;
        const toolId = m.tool_use_id;
        const resumed = toolId ? this.agents.get(this.resumes.get(toolId) ?? '') : undefined;
        if (toolId && resumed) {
          this.alias.set(toolId, resumed.id);
          Object.assign(resumed, { state: 'running', endedAt: null, result: null, summary: null, activity: null, error: null, rev: resumed.rev + 1 });
        }
        const agent = resumed ?? (toolId ? this.agents.get(toolId) : undefined);
        if (agent || m.task_type === 'local_agent') {
          const a = agent ?? this.newAgent(toolId ?? m.task_id, false, oneLine(m.description, 80));
          if (!agent) {
            this.agents.set(a.id, a);
            this.trim(this.agents);
          }
          a.taskId = m.task_id;
          a.background = !!m.is_backgrounded;
          this.alive(a);
          if (a.name === 'agent' && m.description) a.name = oneLine(m.description, 80);
          this.byTask.set(m.task_id, a.id);
        } else if (m.task_type === 'local_workflow') this.startWorkflow(m.task_id, toolId, m.workflow_name, m.description);
        else {
          const bash = toolId ? this.bash.get(toolId) : undefined;
          const p: Proc = {
            id: m.task_id, command: bash?.command || m.description, label: bash?.label ?? null, state: 'running', startedAt: Date.now(),
            endedAt: null, summary: null, exit: null, outputFile: null, inRoster: false,
          };
          if (m.is_backgrounded === false) {
            this.foreground.set(p.id, p);
            // The panel only refreshes on events, so the row is announced when it becomes long.
            setTimeout(() => this.foreground.get(p.id) === p && this.ctx.changed(), FG_SHOW_MS).unref();
          } else this.addProc(p);
        }
        this.ctx.changed();
        return;
      }
      case 'task_updated': {
        const { patch } = m;
        const fg = this.foreground.get(m.task_id);
        if (fg && patch.is_backgrounded) {
          this.foreground.delete(m.task_id);
          this.addProc(fg);
        }
        const a = this.agentByTask(m.task_id);
        this.alive(a);
        if (a && patch.is_backgrounded !== undefined) a.background = patch.is_backgrounded;
        const x = a ?? this.procs.get(m.task_id);
        if (!x) return;
        const st = patch.status === 'completed' ? 'done' : patch.status === 'failed' ? 'failed' : patch.status === 'killed' ? 'stopped' : null;
        if (patch.error && a && (a.state === 'running' || st === 'failed')) a.error = oneLine(patch.error, 300);
        if (st) this.end(x, st);
        if (patch.error && !a) (x as Proc).summary = oneLine(patch.error, 300);
        this.ctx.changed();
        return;
      }
      case 'task_notification': {
        this.foreground.delete(m.task_id);
        const st = m.status === 'completed' ? 'done' : m.status;
        const a = this.agentByTask(m.task_id);
        if (a) {
          this.alive(a);
          if (st === 'failed' && a.state === 'running' && m.summary) a.error ??= oneLine(m.summary, 300);
          this.end(a, st);
          if ((!a.tokens || a.workflow) && m.usage?.total_tokens) a.tokens = m.usage.total_tokens;
          if (!a.result && m.summary) {
            a.result = m.summary.slice(0, RESULT_MAX);
            a.rev++;
          }
        }
        const p = this.procs.get(m.task_id);
        if (p) {
          this.end(p, st);
          p.outputFile = m.output_file || null;
          if (m.summary) p.summary = oneLine(m.summary, 300);
          const code = /exit code (\d+)/.exec(m.summary ?? '');
          if (code) p.exit = Number(code[1]);
        }
        this.ctx.changed();
        return;
      }
      case 'task_progress': {
        const a = this.agentByTask(m.task_id);
        if (!a) return;
        this.alive(a);
        if (m.summary) a.summary = oneLine(m.summary, 120);
        if (m.description && m.description !== a.name) a.activity = oneLine(m.description, 120);
        // A workflow has no messages of its own, so its running total comes only from here.
        if ((!a.tokens || a.workflow) && m.usage.total_tokens) a.tokens = m.usage.total_tokens;
        this.ctx.changed();
        return;
      }
      case 'background_tasks_changed': {
        const live = new Set<string>();
        for (const t of m.tasks) {
          if (t.ambient || t.task_type === 'local_agent' || t.task_type === 'local_workflow') continue;
          live.add(t.task_id);
          const fg = this.foreground.get(t.task_id);
          if (fg) this.foreground.delete(t.task_id);
          const p = this.procs.get(t.task_id) ?? fg ?? null;
          if (p) p.inRoster = true;
          else this.addProc({ id: t.task_id, command: t.description, label: null, state: 'running', startedAt: Date.now(), endedAt: null, summary: null, exit: null, outputFile: null, inRoster: true });
          if (fg) this.addProc(fg);
        }
        // A missed end event must not leave a process "running" forever.
        for (const p of this.procs.values()) if (p.inRoster && !live.has(p.id)) this.end(p, 'done');
        this.ctx.changed();
        return;
      }
    }
  }

  private agentByTask(taskId: string) {
    const id = this.byTask.get(taskId);
    return id ? this.agents.get(id) : undefined;
  }

  private agentById(id: string) {
    return this.agents.get(this.alias.get(id) ?? id);
  }

  private addProc(p: Proc) {
    this.procs.set(p.id, p);
    this.trim(this.procs);
  }

  // Oldest finished entries go first once the list is long.
  private trim<T extends { state: string }>(map: Map<string, T>) {
    for (const [k, v] of map) {
      if (map.size <= KEEP) return;
      if (v.state !== 'running') map.delete(k);
    }
  }

  private window(model: string) {
    const exact = this.windows.get(model);
    if (exact) return exact;
    const family = /opus|sonnet|haiku|fable/.exec(model)?.[0];
    for (const [k, v] of this.windows) if (family && k.includes(family)) return v;
    return WINDOWS.find(([re]) => re.test(model))?.[1] ?? null;
  }

  private row(a: Agent): AgentRow {
    const model = a.modelId ?? a.alias ?? (a.main ? this.ctx.model() : this.main?.modelId ?? this.ctx.model());
    let state = a.state;
    if (state === 'running' && a.pending > 0) state = 'waiting';
    const p = a.progress;
    const steps: Steps | null = p && p.total > 0 ? { total: p.total, done: p.done, avgMs: p.done > 0 ? (p.lastAt - p.startAt) / p.done : null, lastAt: p.lastAt, task: p.task } : null;
    const wf = a.workflow;
    if (wf) {
      return {
        id: a.id, taskId: a.taskId, main: false, name: a.name, model: '', effort: null, state, startedAt: a.startedAt,
        endedAt: state === 'running' || state === 'waiting' ? null : a.endedAt ?? Date.now(), tokens: a.tokens, window: null, steps: null, stepLog: [],
        now: a.summary || a.activity || '', files: [], ...this.short(a), canStop: (state === 'running' || state === 'waiting') && !!a.taskId,
        kind: 'workflow', canMessage: false, agents: wf.kids.size + wf.dropped,
      };
    }
    const more = Math.max(0, a.files.size - ROW_FILES);
    return {
      id: a.id, taskId: a.taskId, main: a.main, name: a.name, model: modelLabel(model), effort: a.main ? this.ctx.effort() : a.effort,
      state, startedAt: a.startedAt, endedAt: state === 'running' || state === 'waiting' ? null : a.endedAt ?? Date.now(),
      tokens: a.tokens, window: this.window(model), steps, stepLog: p?.log ?? [], now: p?.step || a.summary || a.activity || a.lastTool,
      ...(p?.step && a.summary ? { summary: a.summary } : {}),
      files: a.main ? [] : this.newestFiles(a), ...(!a.main && more ? { filesMore: more } : {}),
      ...this.short(a), canStop: (state === 'running' || state === 'waiting') && (a.main || !!a.taskId),
      kind: 'claude', canMessage: !a.main && !!a.taskId,
      // The main row is never drawn, so it skips the fields that change on every step.
      ...(a.main ? {} : { lastAt: lastStamp(a.lastAt), toolUses: a.toolUses, ...(a.shell ? { shell: true as const } : {}) }),
      ...(state === 'failed' && a.error ? { error: a.error } : {}),
    };
  }

  // The agent detail's Activity: Codex runs answer from memory, Claude subagents from their transcripts (read).
  // An adopted run keeps no transcript and a workflow's agents are not read, so both are left out.
  async activity(since: [string, number][], read: (since: [string, number][]) => Promise<WatchSub[]>): Promise<WatchSub[]> {
    const out: WatchSub[] = [];
    const subs: [string, number][] = [];
    for (const [id, rev] of since) {
      const a = this.agents.get(id);
      if (a) {
        if (!a.adopted && !a.workflow) subs.push([id, rev]);
        continue;
      }
      const d = this.external?.activity(id, rev);
      if (d) out.push(d);
    }
    if (subs.length) out.push(...(await read(subs)));
    return out;
  }

  // The Map keeps touch order (oldest first), so the newest are read from its end.
  private newestFiles(a: Agent) {
    const all = [...a.files.values()];
    return all.slice(-ROW_FILES).reverse();
  }

  // What a row carries of the long text; the rest loads with detail().
  private short(a: Agent) {
    let s = this.said.get(a);
    if (s?.rev !== a.rev) {
      const line = a.text.trim().split('\n').filter((l) => l.trim()).pop()?.trim() ?? '';
      s = { rev: a.rev, said: line.slice(0, SAID_MAX) };
      this.said.set(a, s);
    }
    const last = a.followUps.at(-1);
    return { said: s.said, rev: a.rev, followUpCount: a.followUps.length, lastFollowUp: last ? oneLine(last.text, 200) : null };
  }

  detail(id: string): AgentText | null {
    const a = id === 'main' ? this.main : this.agentById(id);
    if (!a) return this.kidDetail(id) ?? this.external?.detail(id) ?? null;
    return { rev: a.rev, task: a.task, text: a.text, result: a.result, followUps: a.followUps };
  }

  snapshot(): Panel {
    const live = (s: string) => s === 'running' || s === 'waiting';
    const runs = [...this.agents.values()];
    const kids = runs.flatMap((a) => (a.workflow ? [...a.workflow.kids.values()].map((k) => this.kidRow(a, k)) : []));
    const subs = [...runs.map((a) => this.row(a)), ...kids, ...(this.external?.rows() ?? [])];
    const agents = [...subs.filter((a) => live(a.state)), ...subs.filter((a) => !live(a.state)).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))];
    // Foreground commands join while they run long; once done they live only in the conversation.
    const now = Date.now();
    const long = [...this.foreground.values()].filter((p) => now - p.startedAt >= FG_SHOW_MS);
    const procs = [...this.procs.values(), ...long].map(({ outputFile: _o, inRoster: _r, ...p }) => p);
    procs.sort((x, y) => Number(y.state === 'running') - Number(x.state === 'running') || y.startedAt - x.startedAt);
    return { active: !!this.main, agents: this.main ? [this.row(this.main), ...agents] : agents, procs };
  }

  // What the session map reads of processes, without building rows; key changes only when that does.
  procState() {
    const now = Date.now();
    let running = 0;
    const failed: Proc[] = [];
    const count = (p: Proc) => (p.state === 'running' ? running++ : p.state === 'failed' && failed.push(p));
    for (const p of this.procs.values()) count(p);
    for (const p of this.foreground.values()) if (now - p.startedAt >= FG_SHOW_MS) count(p);
    failed.sort((x, y) => y.startedAt - x.startedAt);
    const key = `${running}|${failed.map((p) => `${p.id}:${p.exit}:${p.summary ?? ''}`).join('\n')}`;
    return { running, failed, key };
  }

  outputFile(taskId: string) {
    return this.procs.get(taskId)?.outputFile ?? null;
  }

  // A Workflow run: one row fed by its task events, plus its agents read from the run's journal.jsonl.
  private startWorkflow(taskId: string, toolId: string | undefined, name: string | undefined, description: string) {
    const a = this.newAgent(toolId ?? taskId, false, oneLine(name || description || 'workflow', 80));
    Object.assign(a, { taskId, background: true, task: description.slice(0, TASK_MAX), activity: description && description !== a.name ? oneLine(description, 120) : null });
    a.workflow = { dir: this.wfDirs.get(taskId) ?? null, offset: 0, rest: Buffer.alloc(0), kids: new Map(), dropped: 0, timer: null };
    this.wfDirs.delete(taskId);
    this.agents.set(a.id, a);
    this.trim(this.agents);
    this.byTask.set(taskId, a.id);
    this.pollJournal(a);
  }

  // The Workflow tool result names the run's transcript folder; it can arrive before or after task_started.
  private workflowLaunched(structured: unknown, content: unknown) {
    const r = (structured && typeof structured === 'object' ? structured : {}) as Record<string, unknown>;
    const local = r.taskType === 'local_workflow' || (r.taskType === undefined && typeof r.runId === 'string');
    let taskId = local ? str(r.taskId) : '';
    let dir = taskId ? str(r.transcriptDir) : '';
    if (!dir) {
      const head = typeof content === 'string' ? content : Array.isArray(content) ? str((content[0] as Block | undefined)?.text) : '';
      if (!head.startsWith('Workflow launched')) return;
      taskId = /Task ID: (\S+)/.exec(head)?.[1] ?? '';
      dir = /^Transcript dir: (.+)$/m.exec(head)?.[1]?.trim() ?? '';
    }
    if (!taskId || !dir) return;
    const a = this.agentByTask(taskId);
    if (a?.workflow) {
      a.workflow.dir ??= dir;
      return this.pollJournal(a);
    }
    this.wfDirs.set(taskId, dir);
    if (this.wfDirs.size > WF_DIRS_MAX) this.wfDirs.delete(this.wfDirs.keys().next().value!);
  }

  // Reads the journal on a timer while the run is live, then once more after it ends.
  private pollJournal(a: Agent) {
    const w = a.workflow;
    if (!w || w.timer) return;
    w.timer = setTimeout(async () => {
      await this.readJournal(a, w);
      w.timer = null;
      if (a.state === 'running' || a.state === 'waiting') this.pollJournal(a);
      else this.settleKids(a, w);
    }, tuning().journalMs);
    w.timer.unref();
  }

  // Only the bytes appended since the last read, cut at the last full line.
  private async readJournal(a: Agent, w: Workflow) {
    if (!w.dir) return;
    const path = join(w.dir, 'journal.jsonl');
    try {
      const size = (await stat(path)).size;
      if (size < w.offset) Object.assign(w, { offset: 0, rest: Buffer.alloc(0) });
      if (size === w.offset) return;
      const len = Math.min(size - w.offset, JOURNAL_CHUNK);
      const buf = Buffer.allocUnsafe(len);
      const fh = await open(path, 'r');
      let n = 0;
      try {
        n = (await fh.read(buf, 0, len, w.offset)).bytesRead;
      } finally {
        await fh.close();
      }
      w.offset += n;
      const all = Buffer.concat([w.rest, buf.subarray(0, n)]);
      const cut = all.lastIndexOf(10);
      w.rest = Buffer.from(all.subarray(cut + 1));
      if (cut < 0) return;
      let changed = false;
      for (const line of all.subarray(0, cut).toString('utf8').split('\n')) changed = this.journalLine(w, line) || changed;
      if (changed) this.ctx.changed();
    } catch {
      // Not written yet; the next tick tries again.
    }
  }

  // Lines: {type:'started', agentId, label, phase}, {type:'result', agentId, result}, {type:'failed', agentId}; 'launched' names no agent.
  private journalLine(w: Workflow, line: string) {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    const agentId = str(j.agentId);
    if (!agentId || (j.type !== 'started' && j.type !== 'result' && j.type !== 'failed')) return false;
    let k = w.kids.get(agentId);
    if (!k) {
      if (w.kids.size >= WF_AGENTS_MAX) {
        if (j.type !== 'started') return false;
        w.dropped++;
        return true;
      }
      k = { id: `wf:${agentId}`, agentId, name: agentId, phase: '', state: 'running', startedAt: Date.now(), endedAt: null, result: null, said: '', task: null, rev: 0 };
      w.kids.set(agentId, k);
    }
    if (j.type === 'started') {
      k.name = oneLine(str(j.label), 80) || k.name;
      k.phase = oneLine(str(j.phase), 60) || k.phase;
      // A respawned agent logs started again under the same id.
      if (k.state !== 'running') Object.assign(k, { state: 'running', endedAt: null, result: null, said: '', rev: k.rev + 1 });
    } else if (j.type === 'result') {
      const text = typeof j.result === 'string' ? j.result : JSON.stringify(j.result) ?? '';
      const said = text.trim().split('\n').find((l) => l.trim())?.trim() ?? '';
      Object.assign(k, { state: 'done', endedAt: Date.now(), result: text.slice(0, RESULT_MAX), said: said.slice(0, SAID_MAX), rev: k.rev + 1 });
    } else Object.assign(k, { state: 'failed', endedAt: Date.now() });
    return true;
  }

  // Agents with no result line when their run ended did not finish.
  private settleKids(a: Agent, w: Workflow) {
    let changed = false;
    for (const k of w.kids.values()) {
      if (k.state !== 'running') continue;
      Object.assign(k, { state: a.state === 'failed' ? 'failed' : 'stopped', endedAt: a.endedAt ?? Date.now() });
      changed = true;
    }
    if (changed) this.ctx.changed();
  }

  private kidRow(run: Agent, k: WfAgent): AgentRow {
    return {
      id: k.id, taskId: null, main: false, name: k.name, model: '', effort: null, state: k.state, startedAt: k.startedAt,
      endedAt: k.state === 'running' ? null : k.endedAt, tokens: null, window: null, steps: null, stepLog: [], now: '', files: [],
      said: k.said, rev: k.rev, followUpCount: 0, lastFollowUp: null, canStop: false, kind: 'claude', canMessage: false, parent: run.id, phase: k.phase,
    };
  }

  private kidDetail(id: string): AgentText | null {
    if (!id.startsWith('wf:')) return null;
    for (const a of this.agents.values()) {
      const w = a.workflow;
      const k = w?.kids.get(id.slice(3));
      if (!w || !k) continue;
      if (k.task === null) this.loadKidTask(w, k);
      return { rev: k.rev, task: k.task ?? '', text: '', result: k.result, followUps: [] };
    }
    return null;
  }

  // Its prompt is the first line of its own transcript, read once and only when its detail opens.
  private loadKidTask(w: Workflow, k: WfAgent) {
    if (!w.dir) return;
    const path = join(w.dir, `agent-${k.agentId}.jsonl`);
    k.task = '';
    void (async () => {
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.allocUnsafe(PROMPT_HEAD);
        const head = buf.subarray(0, (await fh.read(buf, 0, PROMPT_HEAD, 0)).bytesRead).toString('utf8');
        const nl = head.indexOf('\n');
        const first = JSON.parse(nl < 0 ? head : head.slice(0, nl)) as { message?: { content?: unknown } };
        return fullText(first.message?.content);
      } finally {
        await fh.close();
      }
    })().then(
      (task) => {
        k.task = task.slice(0, TASK_MAX);
        if (!task) return;
        k.rev++;
        this.ctx.changed();
      },
      // Not on disk yet, or a cut line; the next open tries again.
      () => (k.task = null),
    );
  }
}
