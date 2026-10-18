import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentRow, AgentState, AgentText, DiffDetail, DiffLine, FileTouch, Mode, Steps } from '../protocol.ts';
import { diffHunks, unpatch } from '../changes.ts';
import { displayPath, oneLine } from '../text.ts';
import { codexAccount } from './account.ts';
import { tuning } from '../profile.ts';
import { hiddenThreads } from './hidden.ts';
import { startThread, type ApprovalDecision, type CodexApproval, type CodexEvent, type CodexThread } from './threads.ts';
import type { FileUpdateChange, ThreadItem, TurnPlanStep } from './types.ts';

const TEXT_MAX = 6000;
const TASK_MAX = 4000;
const RESULT_MAX = 12000;
// What the main agent reads of a report; the panel keeps up to RESULT_MAX.
const REPORT_MAX = 6000;
const SAID_MAX = 400;
// Finished rows kept in the panel; follow-ups per agent; file-change items remembered for approval cards.
const KEEP = 30;
const FOLLOW_MAX = 20;
const ITEMS_MAX = 50;
// A finished agent's thread stays open this long for follow-ups, then lets the app-server idle out.
const IDLE_CLOSE_MS = 15 * 60_000;
const READ_MAX = 2_000_000;
const DIFF_MAX = 400;

const DEV_NOTE = `You run as a background subagent of another coding agent (Claude Code or Codex, in the tarcsweb web UI). The user watches you in an agents panel.
- For work with 3 or more steps, keep your plan up to date with the plan tool; the panel shows it as your progress.
- End with a short report for the agent that started you: what you did, the files you changed, and anything left undone or uncertain.`;

export type StartArgs = { description: string; prompt: string; model?: string; effort?: string; cwd?: string };
// One approval as the session's permission card shows it.
export type CodexAsk = { agentId: string; tool: string; summary: string; title: string; detail: DiffDetail | null; signal: AbortSignal };

// What the runner needs from its session.
export type CodexHost = {
  cwd: string;
  mode: () => Mode;
  changed: () => void;
  // A file an agent changed, with both texts for the diff cards (note when they could not be worked out).
  edited: (owner: string, path: string, before: string | null, after: string | null, note: string | null, add: number, rm: number) => void;
  ask: (ask: CodexAsk) => Promise<ApprovalDecision>;
  // A turn's end, for the main agent.
  report: (text: string) => void;
};

type StopBy = 'user' | 'agent' | 'session';
type Run = {
  id: string; name: string; thread: CodexThread; task: string;
  state: AgentState; startedAt: number; endedAt: number | null;
  tokens: number | null; window: number | null;
  plan: TurnPlanStep[]; planTask: string; planAt: number; planLast: number; planDone: number;
  activity: string; lastTool: string; files: Map<string, FileTouch>;
  text: string; lastMsg: string; final: string | null; commentary: string | null; error: string | null; result: string | null;
  followUps: { at: number; text: string }[]; rev: number; pending: number;
  changes: Map<string, FileUpdateChange[]>; chain: Promise<void>;
  stopping: StopBy | null; reported: boolean; idle: ReturnType<typeof setTimeout> | undefined; unsub: () => void;
  said: { rev: number; said: string } | null;
};

const lineCount = (s: string) => (s ? s.replace(/\n$/, '').split('\n').length : 0);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readText(path: string) {
  try {
    if ((await stat(path)).size > READ_MAX) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// The present-tense line for an item, like describeTool for Claude's tools.
export function describe(cwd: string, item: ThreadItem) {
  switch (item.type) {
    case 'commandExecution':
      return `Running ${oneLine(item.command.replace(/^\S*\/(ba|z)?sh -lc /, '').replace(/^(["'])([\s\S]*)\1$/, '$2'), 80)}`;
    case 'fileChange':
      return `Editing ${item.changes.map((c) => displayPath(cwd, resolve(cwd, c.path))).join(', ') || 'files'}`;
    case 'mcpToolCall':
      return `${item.tool} · ${item.server}`;
    case 'reasoning':
      return 'Thinking';
    case 'agentMessage':
      return 'Writing';
    case 'webSearch':
      return 'Searching the web';
    default:
      return '';
  }
}

// The card's diff for one Codex change, in the shape diffDetail gives Claude's edits.
export function changeDetail(cwd: string, c: FileUpdateChange): DiffDetail {
  const lines: DiffLine[] = [];
  let add = 0;
  let rm = 0;
  const hunks = diffHunks(c.diff);
  // An added or deleted file comes as its plain content, not as a diff.
  const plain = c.diff ? c.diff.replace(/\n$/, '').split('\n') : [];
  const rows = hunks.length ? hunks.flatMap((h) => h.lines) : plain.map((l) => (c.kind.type === 'delete' ? `-${l}` : `+${l}`));
  for (const l of rows) {
    const k = l[0];
    if (k !== '+' && k !== '-' && k !== ' ') continue;
    if (k === '+') add++;
    if (k === '-') rm++;
    if (lines.length < DIFF_MAX) lines.push([k, l.slice(1)]);
  }
  const path = displayPath(cwd, resolve(cwd, c.path));
  return { kind: 'diff', path, add, rm, lines, more: Math.max(0, add + rm - lines.length), created: c.kind.type === 'add' };
}

// Both texts of one applied change: the file as it is now, and before it by undoing the patch.
export async function changeTexts(cwd: string, c: FileUpdateChange) {
  const path = resolve(cwd, c.path);
  const dest = c.kind.type === 'update' && c.kind.move_path ? resolve(cwd, c.kind.move_path) : path;
  const hunks = diffHunks(c.diff);
  const side = (k: '+' | '-') => hunks.flatMap((h) => h.lines.filter((l) => l[0] === k).map((l) => l.slice(1))).join('\n');
  let add = 0;
  let rm = 0;
  for (const h of hunks) for (const l of h.lines) l[0] === '+' ? add++ : l[0] === '-' && rm++;
  let before: string | null = null;
  let after: string | null = null;
  let note: string | null = null;
  if (c.kind.type === 'add') {
    after = (await readText(dest)) ?? (hunks.length ? side('+') : c.diff);
    if (!hunks.length) add = lineCount(after);
  } else if (c.kind.type === 'delete') {
    before = hunks.length ? side('-') : c.diff;
    after = '';
    if (!hunks.length) rm = lineCount(before);
  } else {
    after = await readText(dest);
    before = after === null ? null : unpatch(after, c.diff);
    if (before === null) note = 'Diff not available';
  }
  return { dest, before, after, note, add, rm };
}

// Codex threads the main agent started, shown as agents panel rows next to Claude's subagents.
export class CodexAgents {
  private host: CodexHost;
  private runs = new Map<string, Run>();
  private ephemeral: boolean;

  constructor(host: CodexHost, opts: { ephemeral?: boolean } = {}) {
    this.host = host;
    this.ephemeral = opts.ephemeral ?? false;
  }

  // Throws with a message the main agent can relay when Codex cannot run.
  async start(args: StartArgs, id: string) {
    const status = codexAccount.status?.signedIn ? codexAccount.status : await codexAccount.check();
    if (!status.installed) throw new Error('The codex CLI is not installed on this machine. Install it, then sign in from Settings > Account in tarcsweb.');
    if (!status.signedIn) throw new Error(`Codex is not signed in${status.error ? ` (${status.error})` : ''}. The user can sign in from Settings > Account in tarcsweb.`);
    if ([...this.runs.values()].filter((r) => r.state === 'running').length >= tuning().codexAgents) {
      throw new Error(`${tuning().codexAgents} Codex agents are already running. Wait for one to finish or stop one first.`);
    }
    const cwd = args.cwd ? resolve(this.host.cwd, args.cwd) : this.host.cwd;
    if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) throw new Error(`The folder ${cwd} does not exist.`);
    const thread = await startThread({
      cwd, model: args.model || undefined, effort: args.effort || undefined, mode: this.host.mode(), developerInstructions: DEV_NOTE, ephemeral: this.ephemeral,
    });
    if (!this.ephemeral) void hiddenThreads.add(thread.id).catch((e: unknown) => console.warn('[codex] agent thread not hidden', e));
    const now = Date.now();
    const run: Run = {
      id, name: oneLine(args.description || 'Codex agent', 80), thread, task: args.prompt.slice(0, TASK_MAX),
      state: 'running', startedAt: now, endedAt: null, tokens: null, window: null,
      plan: [], planTask: '', planAt: now, planLast: now, planDone: 0,
      activity: 'Starting', lastTool: '', files: new Map(), text: '', lastMsg: '', final: null, commentary: null, error: null, result: null,
      followUps: [], rev: 0, pending: 0, changes: new Map(), chain: Promise.resolve(),
      stopping: null, reported: false, idle: undefined, unsub: () => {}, said: null,
    };
    run.unsub = thread.subscribe((e) => this.on(run, e));
    thread.onApproval((a) => this.approve(run, a));
    try {
      await thread.startTurn(args.prompt);
    } catch (e) {
      run.unsub();
      void thread.close();
      throw e;
    }
    this.runs.set(id, run);
    this.trim();
    this.host.changed();
    return { id, threadId: thread.id, model: thread.model, effort: thread.effort };
  }

  // Steers the running turn, or starts a new one on a finished agent whose thread is still open.
  async message(id: string, text: string) {
    const run = this.find(id);
    if (!run) throw new Error(`No Codex agent with id ${id}.`);
    if (run.thread.closed) throw new Error(`Codex agent "${run.name}" has ended and its thread is closed. Start a new Codex agent instead.`);
    run.followUps.push({ at: Date.now(), text: text.slice(0, TASK_MAX) });
    if (run.followUps.length > FOLLOW_MAX) run.followUps.shift();
    run.rev++;
    clearTimeout(run.idle);
    let steered = false;
    try {
      steered = await run.thread.steer(text);
    } catch {}
    if (!steered) {
      this.turnReset(run);
      try {
        await run.thread.startTurn(text, { mode: this.host.mode() });
      } catch (e) {
        // The caller gets the error, so the main agent is not told a second time.
        run.reported = true;
        run.error = oneLine(errText(e), 300);
        this.finish(run, 'failed');
        this.host.changed();
        throw e;
      }
    }
    this.host.changed();
    return steered ? 'steered' as const : 'started' as const;
  }

  // Interrupts the turn and closes the thread; by says who asked, which decides whether the main agent hears of it.
  async stop(id: string, by: StopBy) {
    const run = this.find(id);
    if (!run || run.thread.closed) return false;
    run.stopping = by;
    try {
      await run.thread.interrupt();
    } catch {}
    await run.thread.close();
    return true;
  }

  closeAll() {
    for (const r of this.runs.values()) void this.stop(r.id, 'session');
  }

  byThread(threadId: string) {
    return [...this.runs.values()].find((r) => r.thread.id === threadId)?.id ?? null;
  }

  has(id: string) {
    return this.runs.has(id);
  }

  running() {
    for (const r of this.runs.values()) if (r.state === 'running') return true;
    return false;
  }

  nameOf(id: string) {
    return this.runs.get(id)?.name ?? null;
  }

  detail(id: string): AgentText | null {
    const r = this.runs.get(id);
    return r ? { rev: r.rev, task: r.task, text: r.text, result: r.result, followUps: r.followUps } : null;
  }

  rows(): AgentRow[] {
    return [...this.runs.values()].map((r) => this.row(r));
  }

  private find(id: string) {
    return this.runs.get(id) ?? [...this.runs.values()].find((r) => r.thread.id === id);
  }

  private row(r: Run): AgentRow {
    const live = r.state === 'running';
    const state: AgentState = live && r.pending > 0 ? 'waiting' : r.state;
    const done = r.plan.filter((s) => s.status === 'completed');
    const cur = r.plan.find((s) => s.status === 'inProgress') ?? r.plan.find((s) => s.status === 'pending');
    const steps: Steps | null = r.plan.length
      ? { total: r.plan.length, done: done.length, avgMs: done.length ? (r.planLast - r.planAt) / done.length : null, lastAt: r.planLast, task: r.planTask }
      : null;
    if (r.said?.rev !== r.rev) r.said = { rev: r.rev, said: r.text.trim().split('\n').filter((l) => l.trim()).pop()?.trim().slice(0, SAID_MAX) ?? '' };
    const last = r.followUps.at(-1);
    return {
      id: r.id, taskId: r.thread.id, main: false, name: r.name, model: r.thread.model, effort: r.thread.effort, state, startedAt: r.startedAt,
      endedAt: live ? null : r.endedAt ?? Date.now(), tokens: r.tokens, window: r.window, steps,
      stepLog: [...done.map((s) => s.step), ...(cur ? [cur.step] : [])], now: (live && cur?.step) || (live ? r.activity || r.lastTool : r.error ?? r.lastTool),
      files: [...r.files.values()].reverse(), said: r.said.said, rev: r.rev, followUpCount: r.followUps.length, lastFollowUp: last ? oneLine(last.text, 200) : null,
      canStop: live, kind: 'codex', canMessage: !r.thread.closed,
    };
  }

  private turnReset(r: Run) {
    const now = Date.now();
    Object.assign(r, {
      state: 'running', endedAt: null, final: null, commentary: null, error: null, result: null, stopping: null, reported: false,
      plan: [], planTask: '', planAt: now, planLast: now, planDone: 0, activity: 'Starting', rev: r.rev + 1,
    });
  }

  private on(r: Run, e: CodexEvent) {
    switch (e.type) {
      case 'turn-started':
        if (r.state !== 'running') this.turnReset(r);
        break;
      case 'message-delta':
        if (e.itemId !== r.lastMsg) {
          r.lastMsg = e.itemId;
          if (r.text) r.text += '\n\n';
        }
        r.text = (r.text + e.delta).slice(-TEXT_MAX);
        r.activity = 'Writing';
        r.rev++;
        break;
      case 'item-started': {
        const line = describe(r.thread.cwd, e.item);
        if (line) r.activity = line;
        if (e.item.type === 'fileChange') {
          r.changes.set(e.item.id, e.item.changes);
          if (r.changes.size > ITEMS_MAX) r.changes.delete(r.changes.keys().next().value!);
        }
        break;
      }
      case 'item-completed':
        this.itemDone(r, e.item);
        break;
      case 'plan':
        this.onPlan(r, e.plan, e.explanation);
        break;
      case 'tokens':
        r.tokens = e.usage.last.totalTokens || e.usage.total.totalTokens || r.tokens;
        r.window = e.usage.modelContextWindow ?? r.window;
        break;
      case 'error':
        if (!e.willRetry) r.error = oneLine(e.error.message, 300);
        break;
      case 'turn-completed': {
        const t = e.turn;
        const state: AgentState = t.status === 'completed' ? 'done' : t.status === 'interrupted' ? 'stopped' : 'failed';
        if (t.error) r.error = oneLine(t.error.message, 300);
        this.finish(r, state);
        if (!r.thread.closed) r.idle = setTimeout(() => void r.thread.close(), IDLE_CLOSE_MS);
        r.idle?.unref?.();
        break;
      }
      case 'closed':
        clearTimeout(r.idle);
        if (r.state === 'running') {
          if (!r.stopping) r.error = oneLine(e.reason, 300);
          this.finish(r, r.stopping ? 'stopped' : 'failed');
        }
        r.unsub();
        break;
      default:
        return;
    }
    this.host.changed();
  }

  private itemDone(r: Run, item: ThreadItem) {
    const line = describe(r.thread.cwd, item);
    if (line && item.type !== 'agentMessage' && item.type !== 'reasoning') r.lastTool = line;
    r.activity = '';
    if (item.type === 'agentMessage') {
      if (item.phase === 'commentary') r.commentary = item.text;
      else r.final = item.text;
      // A message that never streamed as deltas still belongs in the output.
      if (item.id !== r.lastMsg && item.text) {
        r.lastMsg = item.id;
        r.text = ((r.text ? `${r.text}\n\n` : '') + item.text).slice(-TEXT_MAX);
        r.rev++;
      }
    } else if (item.type === 'fileChange') {
      r.changes.delete(item.id);
      if (item.status === 'completed') {
        const changes = item.changes;
        r.chain = r.chain.then(() => this.applied(r, changes)).catch((err) => console.warn('[codex] file change not recorded', err));
      }
    }
  }

  private onPlan(r: Run, plan: TurnPlanStep[], explanation: string | null) {
    const done = plan.filter((s) => s.status === 'completed').length;
    const now = Date.now();
    if (!r.plan.length) r.planAt = now;
    if (done !== r.planDone) r.planLast = now;
    r.planDone = done;
    r.plan = plan.slice(0, 50).map((s) => ({ step: oneLine(s.step, 120), status: s.status }));
    if (explanation) r.planTask = oneLine(explanation, 120);
  }

  private async applied(r: Run, changes: FileUpdateChange[]) {
    for (const c of changes) {
      const { dest, before, after, note, add, rm } = await changeTexts(r.thread.cwd, c);
      this.host.edited(r.id, dest, before, after, note, add, rm);
      const key = displayPath(this.host.cwd, dest);
      const prev = r.files.get(key);
      r.files.delete(key);
      r.files.set(key, { path: key, mode: 'edited', add: (prev?.add ?? 0) + add, rm: (prev?.rm ?? 0) + rm, at: Date.now() });
    }
    this.host.changed();
  }

  private async approve(r: Run, a: CodexApproval): Promise<ApprovalDecision> {
    const who = `Codex · ${r.name}${a.reason ? ` — ${oneLine(a.reason, 160)}` : ''}`;
    let ask: CodexAsk;
    if (a.kind === 'command') {
      ask = { agentId: r.id, tool: 'Bash', summary: oneLine(a.command ?? 'a command', 300), title: who, detail: null, signal: a.signal };
    } else if (a.kind === 'fileChange') {
      const changes = r.changes.get(a.itemId) ?? [];
      const paths = changes.map((c) => displayPath(this.host.cwd, resolve(r.thread.cwd, c.path)));
      const detail = changes.length === 1 ? changeDetail(this.host.cwd, changes[0]) : null;
      ask = { agentId: r.id, tool: changes.every((c) => c.kind.type === 'add') && changes.length ? 'Write' : 'Edit', summary: paths.join(', ') || a.grantRoot || 'files', title: who, detail, signal: a.signal };
    } else {
      const want = Object.entries((a.permissions ?? {}) as Record<string, unknown>).filter(([, v]) => v != null).map(([k]) => (k === 'fileSystem' ? 'file system' : k));
      ask = { agentId: r.id, tool: 'Permissions', summary: `More access: ${want.join(', ') || 'unspecified'}`, title: who, detail: null, signal: a.signal };
    }
    r.pending++;
    this.host.changed();
    try {
      return await this.host.ask(ask);
    } finally {
      r.pending--;
      this.host.changed();
    }
  }

  private finish(r: Run, state: AgentState) {
    if (r.state !== 'running') return;
    r.state = state;
    r.endedAt = Date.now();
    r.activity = '';
    const report = r.final ?? r.commentary ?? '';
    r.result = (report || r.error || '').slice(0, RESULT_MAX) || null;
    r.rev++;
    // The main agent asked for the stop itself; a closing session has nobody to tell.
    if (r.reported || r.stopping === 'agent' || r.stopping === 'session') return;
    r.reported = true;
    const status = state === 'done' ? 'completed' : state === 'stopped' ? 'killed' : 'failed';
    const how = state === 'done' ? 'completed' : state === 'stopped' ? 'was stopped by the user' : `failed${r.error ? `: ${r.error}` : ''}`;
    const body = report.length > REPORT_MAX ? `${report.slice(0, REPORT_MAX)}\n[cut; the full report is in the agents panel]` : report;
    this.host.report([
      '<task-notification>',
      `<task-id>${r.thread.id}</task-id>`,
      `<tool-use-id>${r.id}</tool-use-id>`,
      `<status>${status}</status>`,
      `<summary>Codex agent "${r.name}" (${r.thread.model}) ${how}</summary>`,
      ...(body ? [`<result>${body}</result>`] : []),
      '</task-notification>',
      `This is the result of Codex agent ${r.id}.${state === 'done' && !r.thread.closed ? ' Send it a follow-up with mcp__app__codex_message if needed.' : ''}`,
    ].join('\n'));
  }

  // Oldest finished rows go first once the list is long.
  private trim() {
    for (const [k, r] of this.runs) {
      if (this.runs.size <= KEEP) return;
      if (r.state === 'running') continue;
      clearTimeout(r.idle);
      void r.thread.close();
      this.runs.delete(k);
    }
  }
}
