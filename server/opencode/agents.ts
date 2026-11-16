import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentLive, AgentRow, AgentState, AgentText, FileTouch, WatchEntry, WatchSub } from '../protocol.ts';
import type { CodexHost } from '../codex/agents.ts';
import { changeTexts, changeDetail } from '../codex/agents.ts';
import { lastStamp } from '../agents.ts';
import { displayPath, oneLine } from '../text.ts';
import { tuning } from '../profile.ts';
import { opencodeAccount } from './account.ts';
import { opencode, type PermissionRequest } from './client.ts';
import { hiddenThreads } from './hidden.ts';
import { startThread, type OpencodeThread, type OpencodeThreadEvent, type Tool, type Edit } from './threads.ts';

export type OpencodeStartArgs = { description: string; prompt: string; model?: string; effort?: string; cwd?: string };
type StopBy = 'user' | 'agent' | 'session';
type Run = {
  id: string; name: string; task: string; thread: OpencodeThread; state: AgentState;
  startedAt: number; endedAt: number | null; lastAt: number; pending: number; rev: number;
  text: string; final: string; result: string | null; error: string | null; live: AgentLive | null;
  plan: { content: string; status: string }[]; planAt: number; planLast: number;
  files: Map<string, FileTouch>; tokens: number | null; used: number | null; window: number | null;
  activity: string; toolUses: number; shell: boolean; stopping: StopBy | null; reported: boolean;
  followUps: { at: number; text: string }[]; acts: WatchEntry[]; actRev: number;
  actRevs: WeakMap<WatchEntry, number>; dropped: number; open: Map<string, WatchEntry>;
  unsub: () => void; idle?: ReturnType<typeof setTimeout>; chain: Promise<void>;
};
const DEV_NOTE = `You run as a background subagent of another coding agent in tarcsweb. The user watches your activity in the agents panel.
- For work with 3 or more steps, keep your todo list up to date.
- End with a short report: what you did, files changed, and anything unfinished or uncertain.`;
const errText = (e: unknown) => e instanceof Error ? e.message : String(e);

export class OpencodeAgents {
  private runs = new Map<string, Run>();
  private starting = 0;
  private closed = false;
  private host: CodexHost;
  constructor(host: CodexHost) { this.host = host; }

  async start(args: OpencodeStartArgs, id: string) {
    if (this.closed) throw new Error('The session is closed.');
    if (this.starting + [...this.runs.values()].filter(r => r.state === 'running').length >= tuning().opencodeAgents) {
      throw new Error(`${tuning().opencodeAgents} OpenCode agents are already running. Wait for one to finish or stop one first.`);
    }
    this.starting++;
    let thread: OpencodeThread | undefined;
    try {
      const cwd = args.cwd ? resolve(this.host.cwd, args.cwd) : this.host.cwd;
      if (!(await stat(cwd).then(s => s.isDirectory(), () => false))) throw new Error(`The folder ${cwd} does not exist.`);
      const location = { directory: cwd };
      const status = await opencodeAccount.get(location);
      if (!status.installed) throw new Error('The opencode CLI is not installed. Install OpenCode 2.x first.');
      if (!status.versionOk) throw new Error('OpenCode 2.x is required.');
      if (!status.connected) throw new Error(`No usable OpenCode model. Run \`opencode auth login\` in a terminal.${status.error ? ` ${status.error}` : ''}`);
      const defaultModel = args.model ? null : (await opencode.defaultModel(location)).data;
      const model = args.model ?? (defaultModel ? `opencode:${defaultModel.providerID}/${defaultModel.id}` : null);
      if (!model) throw new Error('No usable OpenCode default model. Run `opencode auth login` in a terminal.');
      const catalog = await opencodeAccount.models(location);
      const selected = catalog.find(m => m.id === model);
      if (!selected) throw new Error(`OpenCode model ${model} is unavailable. Run \`opencode auth login\` in a terminal.`);
      if (args.effort && !selected.efforts.includes(args.effort)) throw new Error(`OpenCode variant ${args.effort} is unavailable for ${model}. Available variants: ${selected.efforts.join(', ') || 'none'}.`);
      thread = await startThread({ cwd, model, effort: args.effort, mode: this.host.mode(), instructions: DEV_NOTE, subagents: false });
      await hiddenThreads.add(thread.id);
      if (this.closed) throw new Error('The session is closed.');
      const now = Date.now();
      const r: Run = {
        id, name: oneLine(args.description || 'OpenCode agent', 80), task: args.prompt.slice(0, 4000), thread,
        state: 'running', startedAt: now, endedAt: null, lastAt: now, pending: 0, rev: 0,
        text: '', final: '', result: null, error: null, live: null, plan: [], planAt: now, planLast: now,
        files: new Map(), tokens: null, used: null, window: selected.contextWindow, activity: 'Starting', toolUses: 0, shell: false,
        stopping: null, reported: false, followUps: [], acts: [], actRev: 0, actRevs: new WeakMap(), dropped: 0, open: new Map(),
        unsub: () => {}, chain: Promise.resolve(),
      };
      this.runs.set(id, r);
      r.unsub = thread.subscribe(e => this.on(r, e));
      thread.onApproval(a => this.approve(r, a));
      thread.onForm(async () => null);
      await thread.startTurn(args.prompt);
      this.trim();
      this.host.changed();
      return { id, threadId: thread.id, model: thread.model, effort: thread.effort };
    } catch (error) {
      const r = this.runs.get(id);
      if (r) { r.reported = true; r.error = errText(error); this.finish(r, 'failed'); }
      await thread?.close();
      throw error;
    } finally { this.starting--; }
  }

  async message(id: string, text: string) {
    const r = this.find(id);
    if (!r) throw new Error(`No OpenCode agent with id ${id}.`);
    if (r.thread.closed) throw new Error('This OpenCode agent is closed. Start a new agent.');
    if (r.state !== 'running' && this.starting + [...this.runs.values()].filter(run => run.state === 'running').length >= tuning().opencodeAgents) {
      throw new Error(`${tuning().opencodeAgents} OpenCode agents are already running. Wait for one to finish or stop one first.`);
    }
    clearTimeout(r.idle);
    r.followUps.push({ at: Date.now(), text: text.slice(0, 4000) });
    if (r.followUps.length > 20) r.followUps.shift();
    r.rev++;
    try {
      if (r.thread.mode !== this.host.mode()) await r.thread.setMode(this.host.mode());
      if (await r.thread.steer(text)) { this.host.changed(); return 'steered' as const; }
      this.reset(r);
      await r.thread.startTurn(text);
      this.host.changed();
      return 'started' as const;
    } catch (error) {
      r.reported = true; r.error = errText(error); this.finish(r, 'failed'); this.host.changed();
      throw error;
    }
  }

  async stop(id: string, by: StopBy) {
    const r = this.find(id);
    if (!r || r.thread.closed) return false;
    r.stopping = by;
    await r.thread.close();
    return true;
  }
  closeAll() {
    this.closed = true;
    return Promise.allSettled([...this.runs.values()].map(r => this.stop(r.id, 'session')));
  }
  byThread(id: string) { return [...this.runs.values()].find(r => r.thread.id === id)?.id ?? null; }
  has(id: string) { return this.runs.has(id); }
  running() { return this.starting > 0 || [...this.runs.values()].some(r => r.state === 'running'); }
  nameOf(id: string) { return this.runs.get(id)?.name ?? null; }
  private find(id: string) { return this.runs.get(id) ?? this.runs.get(this.byThread(id) ?? ''); }
  detail(id: string): AgentText | null {
    const r = this.runs.get(id);
    return r ? { rev: r.rev, task: r.task, text: r.text, result: r.result, followUps: r.followUps, live: r.live } : null;
  }
  activity(id: string, rev: number): WatchSub | null {
    const r = this.runs.get(id);
    return !r || r.actRev === rev ? null : { aid: id, rev: r.actRev, more: r.dropped, entries: r.acts.filter(e => !rev || (r.actRevs.get(e) ?? 0) > rev) };
  }
  rows(): AgentRow[] {
    return [...this.runs.values()].map(r => {
      const live = r.state === 'running';
      const done = r.plan.filter(s => s.status === 'completed');
      const cur = r.plan.find(s => s.status === 'in_progress') ?? r.plan.find(s => s.status === 'pending');
      return {
        id: r.id, taskId: r.thread.id, main: false, kind: 'opencode', name: r.name, model: r.thread.model, effort: r.thread.effort,
        state: live && r.pending ? 'waiting' : r.state, startedAt: r.startedAt, endedAt: r.endedAt,
        tokens: r.tokens, window: r.window, steps: r.plan.length ? { total: r.plan.length, done: done.length, avgMs: done.length ? (r.planLast - r.planAt) / done.length : null, lastAt: r.planLast, task: '' } : null,
        stepLog: [...done.map(s => s.content), ...(cur ? [cur.content] : [])], now: (live && cur?.content) || r.activity,
        files: [...r.files.values()].reverse(), said: r.text.trim().split('\n').at(-1)?.slice(0, 400) ?? '', rev: r.rev,
        followUpCount: r.followUps.length, lastFollowUp: r.followUps.at(-1)?.text.slice(0, 200) ?? null,
        canStop: live, canMessage: !r.thread.closed, lastAt: lastStamp(r.lastAt), toolUses: r.toolUses,
        ...(r.shell ? { shell: true as const } : {}), ...(r.used !== null ? { used: r.used } : {}),
        ...(r.endedAt ? { durationMs: r.endedAt - r.startedAt } : {}), ...(r.error ? { error: r.error } : {}),
      };
    });
  }

  private reset(r: Run) {
    Object.assign(r, { state: 'running', endedAt: null, final: '', result: null, error: null, live: null, plan: [], planAt: Date.now(), planLast: Date.now(), stopping: null, reported: false, activity: 'Starting', rev: r.rev + 1 });
  }
  private act(r: Run, entry: WatchEntry) {
    if (!r.acts.includes(entry)) r.acts.push(entry);
    r.actRevs.set(entry, ++r.actRev);
    if (r.acts.length > 220) { const n = r.acts.length - 200; r.acts.splice(0, n); r.dropped += n; }
    return entry;
  }
  private on(r: Run, e: OpencodeThreadEvent) {
    if (e.sessionID !== r.thread.id) return;
    r.lastAt = Date.now();
    switch (e.type) {
      case 'turn-started': if (r.state !== 'running') this.reset(r); break;
      case 'message-delta':
        if (r.live?.id !== e.itemId) { r.live = { id: e.itemId, at: Date.now(), text: '' }; r.text += r.text ? '\n\n' : ''; }
        r.text = (r.text + e.delta).slice(-6000);
        if (!r.live.cut) { const text = r.live.text + e.delta; r.live.text = text.slice(0, 12000); if (text.length > 12000) r.live.cut = true; }
        r.activity = 'Writing'; r.rev++; break;
      case 'message-final':
        if (r.live?.id !== e.itemId) r.text = `${r.text}\n\n${e.text}`.slice(-6000);
        r.final = e.text.slice(0, 12000); r.rev++;
        this.act(r, { k: 'text', id: e.itemId, mid: e.itemId, at: r.live?.id === e.itemId ? r.live.at : Date.now(), s: oneLine(e.text, 120), t: e.text.slice(0, 4000), ...(e.text.length > 4000 ? { cut: true } : {}) }); break;
      case 'reasoning-delta': r.activity = 'Thinking'; break;
      case 'plan':
        r.plan = e.todos.slice(0, 50); r.planLast = Date.now();
        this.act(r, { k: 'plan', id: `plan:${r.actRev}`, at: Date.now(), plan: { title: r.name, steps: r.plan.map(s => ({ text: s.content, status: s.status === 'completed' ? 'done' : s.status === 'in_progress' ? 'doing' : 'todo' })) } }); break;
      case 'tokens': {
        const u = e.usage;
        const cache = u.cache && typeof u.cache === 'object' ? u.cache as Record<string, unknown> : {};
        const total = typeof u.total === 'number' ? u.total : ['input', 'output', 'reasoning'].reduce((sum, k) => sum + (typeof u[k] === 'number' ? u[k] as number : 0), 0) + (typeof cache.read === 'number' ? cache.read : 0) + (typeof cache.write === 'number' ? cache.write : 0);
        if (e.cumulative) r.used = total; else r.tokens = total;
        r.window = e.contextWindow ?? r.window; break;
      }
      case 'tool-start': case 'tool-update': case 'tool-end': this.tool(r, e.tool, e.type === 'tool-end'); break;
      case 'error': r.error = e.error; this.act(r, { k: 'error', id: `error:${r.actRev}`, at: Date.now(), s: oneLine(e.error, 300) }); break;
      case 'turn-ended':
        r.error = e.error ?? r.error;
        this.finish(r, e.status === 'succeeded' ? 'done' : e.status === 'interrupted' ? 'stopped' : 'failed');
        clearTimeout(r.idle);
        r.idle = setTimeout(() => void r.thread.close().catch(error => console.warn('[opencode] agent close failed', error)), 15 * 60_000); r.idle.unref(); break;
      case 'closed':
        clearTimeout(r.idle);
        if (r.state === 'running') { r.error ??= r.stopping ? null : 'OpenCode stopped before finishing.'; this.finish(r, r.stopping ? 'stopped' : 'failed'); }
        r.unsub(); break;
      default: return;
    }
    this.host.changed();
  }
  private tool(r: Run, tool: Tool, ended: boolean) {
    const input = typeof tool.input === 'string' ? { text: tool.input } : tool.input;
    let entry = r.open.get(tool.id);
    if (!entry) {
      r.toolUses++; r.shell = tool.name === 'shell';
      entry = this.act(r, { k: 'tool', id: tool.id, at: tool.startedAt, verb: tool.name === 'shell' ? 'run' : tool.name.slice(0, 16), s: oneLine(String(input.command ?? input.path ?? input.text ?? tool.name), 120) });
      r.open.set(tool.id, entry);
    }
    r.activity = entry.s ?? tool.name;
    if (tool.output !== undefined) entry.out = (typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output)).slice(-600);
    if (ended) {
      entry.end = Date.now();
      if (tool.status === 'failed') { entry.err = true; entry.why = tool.error ?? 'Failed'; }
      r.open.delete(tool.id);
      if (tool.status === 'completed' && tool.edits?.length) r.chain = r.chain.then(() => this.edited(r, tool.edits!)).catch(error => console.warn('[opencode] file change not recorded', error));
    }
    this.act(r, entry);
  }
  private async edited(r: Run, edits: Edit[]) {
    for (const edit of edits) {
      const path = resolve(r.thread.cwd, edit.path);
      const change = { path, kind: { type: 'update' as const, move_path: null }, diff: edit.patch ?? '' };
      const texts = edit.patch ? await changeTexts(r.thread.cwd, change) : null;
      const before = texts ? texts.before : edit.before ?? null;
      const after = texts ? texts.after : edit.after ?? null;
      const add = texts?.add ?? (after?.split('\n').length ?? 0);
      const rm = texts?.rm ?? (before?.split('\n').length ?? 0);
      this.host.edited(r.id, path, before, after, before === null || after === null ? 'Diff not available' : null, add, rm);
      const key = displayPath(this.host.cwd, path);
      const prev = r.files.get(key);
      r.files.delete(key); r.files.set(key, { path: key, mode: 'edited', add: (prev?.add ?? 0) + add, rm: (prev?.rm ?? 0) + rm, at: Date.now() });
      if (r.files.size > 100) r.files.delete(r.files.keys().next().value!);
    }
    this.host.changed();
  }
  private async approve(r: Run, a: PermissionRequest & { signal: AbortSignal }) {
    const shell = a.action === 'shell';
    const edit = a.action === 'edit';
    const paths = edit ? a.resources.map(p => resolve(r.thread.cwd, p)) : [];
    const command = shell ? String(a.metadata?.command ?? a.resources.join(', ')) : undefined;
    const files = Array.isArray(a.metadata?.files) ? a.metadata.files as { file: string; patch: string }[] : [];
    const detail = edit && files.length === 1 ? changeDetail(this.host.cwd, { path: resolve(r.thread.cwd, files[0].file), kind: { type: 'update', move_path: null }, diff: files[0].patch }) : null;
    r.pending++; this.host.changed();
    try {
      const decision = await this.host.ask({ agentId: r.id, tool: shell ? 'Bash' : edit ? 'Edit' : 'Permissions', summary: oneLine(command ?? (a.resources.join(', ') || a.action), 300), command, title: `OpenCode · ${r.name}`, detail, signal: a.signal,
        ...(shell ? { facts: { tool: 'Bash', command, cwd: r.thread.cwd } } : edit ? { facts: { tool: 'Edit', paths } } : {}) });
      return decision === 'accept' ? 'once' as const : decision === 'acceptForSession' ? 'always' as const : 'reject' as const;
    } finally { r.pending--; this.host.changed(); }
  }
  private finish(r: Run, state: AgentState) {
    if (r.state !== 'running') return;
    r.state = state; r.endedAt = Date.now(); r.activity = ''; r.result = r.final || r.error; r.rev++;
    if (r.error) this.act(r, { k: 'error', id: `error:${r.actRev}`, at: r.endedAt, s: oneLine(r.error, 300) });
    this.act(r, { k: 'turn-end', id: `end:${r.actRev}`, at: r.endedAt, state });
    for (const entry of r.open.values()) { entry.end = r.endedAt; this.act(r, entry); }
    r.open.clear();
    if (r.reported || r.stopping === 'session' || r.stopping === 'agent') return;
    r.reported = true;
    const status = state === 'done' ? 'completed' : state === 'stopped' ? 'killed' : 'failed';
    this.host.report(`<task-notification>\n<task-id>${r.thread.id}</task-id>\n<tool-use-id>${r.id}</tool-use-id>\n<status>${status}</status>\n<summary>OpenCode agent "${r.name}" ${status}${r.error ? `: ${r.error}` : ''}</summary>\n<result>${(r.result ?? '').slice(0, 6000)}</result>\n</task-notification>\nThis is the result of OpenCode agent ${r.id}. Send a follow-up with mcp__app__opencode_message if needed.`, r.id);
  }
  private trim() {
    for (const [id, r] of this.runs) {
      if (this.runs.size <= 30) break;
      if (r.state === 'running') continue;
      clearTimeout(r.idle); void r.thread.close().catch(error => console.warn('[opencode] agent close failed', error)); this.runs.delete(id);
    }
  }
}
