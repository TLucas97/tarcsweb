import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRow, AgentState, AgentText, FileTouch, Panel, ProcRow, ProcState, Steps } from './protocol.ts';
import { displayPath, oneLine } from './text.ts';
import { PLUMBING, describeTool } from './tools.ts';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const PROGRESS_TOOL = 'mcp__agents-panel__progress';
const TEXT_MAX = 6000;
const TASK_MAX = 4000;
const RESULT_MAX = 12000;
const KEEP = 30;
const SAID_MAX = 400;
// Quick foreground commands stay out of the Processes list; past this they show there too.
const FG_SHOW_MS = 10_000;
// Used until a result reports modelUsage.contextWindow; the 5.x CLI reported 1M for haiku 5.5 too.
const WINDOWS: [RegExp, number][] = [[/opus|sonnet|haiku|fable/, 1_000_000]];

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };

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
};

type Proc = ProcRow & { outputFile: string | null; inRoster: boolean };

// Agents that run outside the CLI (Codex threads), merged into the same panel.
export type ExternalAgents = { rows(): AgentRow[]; running(): boolean; detail(id: string): AgentText | null; nameOf(id: string): string | null };

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
      background: false, tokens: null, progress: null, summary: null, activity: null, lastTool: '', files: new Map(), text: '', pending: 0, task: '', followUps: [], result: null, rev: 0,
    };
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

  permission(toolUseId: string, agentId: string | undefined, on: boolean) {
    const byAgent = agentId ? this.byTask.get(agentId) : undefined;
    const id = this.owner.get(toolUseId) ?? byAgent ?? 'main';
    const a = id === 'main' ? this.main : this.agentById(id);
    if (!a) return;
    a.pending = Math.max(0, a.pending + (on ? 1 : -1));
    this.ctx.changed();
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
        return this.onToolResults(m.message.content);
      case 'stream_event': {
        const parent = m.parent_tool_use_id;
        if (!parent) return;
        const ev = m.event;
        if (ev.type === 'message_start') this.streamMsg.set(parent, ev.message.id);
        else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          const a = this.agentById(parent);
          const msgId = this.streamMsg.get(parent);
          if (!a || !msgId) return;
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

  private onToolUse(a: Agent, id: string, name: string, input: Record<string, unknown>) {
    this.owner.set(id, a.id);
    if (name === PROGRESS_TOOL) {
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
      return;
    }
    if (!PLUMBING.has(name)) a.lastTool = describeTool(this.cwd, name, input);
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

  private onToolResults(content: unknown) {
    if (!Array.isArray(content)) return;
    for (const b of content as Block[]) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      const call = this.fileCalls.get(b.tool_use_id);
      if (call) {
        this.fileCalls.delete(b.tool_use_id);
        if (!b.is_error) this.touchFiles(call.agent, call.name, call.input);
        this.ctx.changed();
      }
      const a = this.agentById(b.tool_use_id);
      // A background agent's result is only the "running in the background" placeholder; a SendMessage result is only a receipt.
      if (!a || a.background || a.state !== 'running' || this.resumes.has(b.tool_use_id)) continue;
      if (b.is_error) a.summary = resultLine(b.content) || a.summary;
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
          Object.assign(resumed, { state: 'running', endedAt: null, result: null, summary: null, activity: null, rev: resumed.rev + 1 });
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
          if (a.name === 'agent' && m.description) a.name = oneLine(m.description, 80);
          this.byTask.set(m.task_id, a.id);
        } else if (m.task_type !== 'local_workflow') {
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
        if (a && patch.is_backgrounded !== undefined) a.background = patch.is_backgrounded;
        const x = a ?? this.procs.get(m.task_id);
        if (!x) return;
        const st = patch.status === 'completed' ? 'done' : patch.status === 'failed' ? 'failed' : patch.status === 'killed' ? 'stopped' : null;
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
          this.end(a, st);
          if (!a.tokens && m.usage) a.tokens = m.usage.total_tokens;
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
        if (m.summary) a.summary = oneLine(m.summary, 120);
        if (m.description && m.description !== a.name) a.activity = oneLine(m.description, 120);
        if (!a.tokens && m.usage.total_tokens) a.tokens = m.usage.total_tokens;
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
    return {
      id: a.id, taskId: a.taskId, main: a.main, name: a.name, model: modelLabel(model), effort: a.main ? this.ctx.effort() : a.effort,
      state, startedAt: a.startedAt, endedAt: state === 'running' || state === 'waiting' ? null : a.endedAt ?? Date.now(),
      tokens: a.tokens, window: this.window(model), steps, stepLog: p?.log ?? [], now: p?.step || a.summary || a.activity || a.lastTool,
      files: [...a.files.values()].reverse(), ...this.short(a), canStop: (state === 'running' || state === 'waiting') && (a.main || !!a.taskId),
      kind: 'claude', canMessage: !a.main && !!a.taskId,
    };
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
    if (!a) return this.external?.detail(id) ?? null;
    return { rev: a.rev, task: a.task, text: a.text, result: a.result, followUps: a.followUps };
  }

  snapshot(): Panel {
    const live = (s: string) => s === 'running' || s === 'waiting';
    const subs = [...[...this.agents.values()].map((a) => this.row(a)), ...(this.external?.rows() ?? [])];
    const agents = [...subs.filter((a) => live(a.state)), ...subs.filter((a) => !live(a.state)).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))];
    // Foreground commands join while they run long; once done they live only in the conversation.
    const now = Date.now();
    const long = [...this.foreground.values()].filter((p) => now - p.startedAt >= FG_SHOW_MS);
    const procs = [...this.procs.values(), ...long].map(({ outputFile: _o, inRoster: _r, ...p }) => p);
    procs.sort((x, y) => Number(y.state === 'running') - Number(x.state === 'running') || y.startedAt - x.startedAt);
    return { active: !!this.main, agents: this.main ? [this.row(this.main), ...agents] : agents, procs };
  }

  outputFile(taskId: string) {
    return this.procs.get(taskId)?.outputFile ?? null;
  }
}
