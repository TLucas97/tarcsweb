import { randomUUID } from 'node:crypto';
import { query, type CanUseTool, type HookCallback, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MODEL_IDS, providerOf, type ClaudeEffort, type Mode } from './protocol.ts';
import { modelLabel, type AgentTracker } from './agents.ts';
import { PromptQueue } from './promptQueue.ts';
import { progressServer } from './modTools.ts';
import { connect } from './connect.ts';
import { PROGRESS_TOOL } from './tools.ts';
import { oneLine } from './text.ts';

// Each run is a Claude Code process (~300 MB), so few run at once and few stay for follow-ups.
const RUNNING_MAX = 4;
const IDLE_MAX = 2;
const IDLE_CLOSE_MS = 5 * 60_000;
// What the main agent reads of a report; the panel keeps the full result.
const REPORT_MAX = 6000;
const DEFAULT_MODEL = 'claude-sonnet-5-5';

const SUB_NOTE = `# Background subagent

You run as a background subagent of another coding agent (OpenAI Codex, in the tarcsweb web UI). The user watches you in an agents panel; nobody reads your messages until you finish.
- For work with 3 or more steps, call ${PROGRESS_TOOL} with {task, total, done: 0, step} at the start and again each time a step finishes (done + 1, next step).
- End with a short report for the agent that started you: what you did, the files you changed, and anything left undone or uncertain.`;

export type ClaudeStartArgs = { description: string; prompt: string; model?: string; effort?: ClaudeEffort };

// What the runner needs from its session; rows, text, progress and file touches go through the session's AgentTracker.
export type ClaudeHost = {
  cwd: string;
  mode: () => Mode;
  tracker: AgentTracker;
  // The permission card for one run, owned by its row.
  ask: (runId: string, name: string) => CanUseTool;
  // A successful file tool call, for the diff cards.
  edited: (runId: string, tool: string, input: unknown, response: unknown) => void;
  // A turn's end, for the main agent.
  report: (text: string) => void;
};

type StopBy = 'user' | 'agent' | 'session';
type Run = {
  id: string; name: string; model: string; q: Query; queue: PromptQueue;
  busy: boolean; open: boolean; stopping: StopBy | null; idleAt: number; idle: ReturnType<typeof setTimeout> | undefined;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Claude Code subagents a Codex main started with claude_agent, shown as agents panel rows like the Agent tool's.
export class ClaudeAgents {
  private host: ClaudeHost;
  private runs = new Map<string, Run>();

  constructor(host: ClaudeHost) {
    this.host = host;
  }

  // Throws with a message the main agent can relay when Claude cannot run.
  async start(args: ClaudeStartArgs, id: string) {
    const status = connect.status?.loggedIn ? connect.status : await connect.check();
    if (!status.loggedIn) throw new Error(`Claude Code is not signed in${status.error ? ` (${status.error})` : ''}. The user can sign in from Settings > Account in tarcsweb.`);
    if ([...this.runs.values()].filter((r) => r.busy).length >= RUNNING_MAX) {
      throw new Error(`${RUNNING_MAX} Claude agents are already running. Wait for one to finish or stop one first.`);
    }
    const model = args.model?.trim() || DEFAULT_MODEL;
    if (providerOf(model) !== 'claude') throw new Error(`${model} is not a Claude model. Use one of ${MODEL_IDS.join(', ')}.`);
    const name = oneLine(args.description || 'Claude agent', 80);
    const queue = new PromptQueue();
    const mode = this.host.mode();
    const fileHook: HookCallback = async (input) => {
      if (input.hook_event_name === 'PostToolUse') {
        try {
          this.host.edited(id, input.tool_name, input.tool_input, input.tool_response);
        } catch {}
      }
      return {};
    };
    const q = query({
      prompt: queue,
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SUB_NOTE },
        cwd: this.host.cwd,
        model,
        ...(args.effort ? { effort: args.effort } : {}),
        permissionMode: mode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        // No transcript: it is not a session of its own, and follow-ups only reach it while its process lives.
        persistSession: false,
        mcpServers: { 'agents-panel': progressServer() },
        allowedTools: [PROGRESS_TOOL],
        // Nested agents would not show in the panel, and a plan approval would switch the main tab's mode.
        disallowedTools: ['Agent', 'Task', 'ExitPlanMode'],
        canUseTool: this.host.ask(id, name),
        hooks: { PostToolUse: [{ matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [fileHook] }] },
        ...(process.env.CW_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CW_CLAUDE_BIN } : {}),
        extraArgs: { settings: JSON.stringify({ env: { TARCSWEB: '1', CLAUDE_WEB: '1' } }) },
      },
    });
    const run: Run = { id, name, model, q, queue, busy: true, open: true, stopping: null, idleAt: 0, idle: undefined };
    this.runs.set(id, run);
    this.host.tracker.adopt(id, name, model, args.effort ?? null, args.prompt);
    queue.push({ type: 'user', message: { role: 'user', content: args.prompt }, parent_tool_use_id: null, uuid: randomUUID() });
    void this.consume(run);
    return { id, model: modelLabel(model), effort: args.effort ?? null };
  }

  // Queues a message: a running agent reads it after its current step; an idle one starts a new turn.
  message(id: string, text: string) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`No Claude agent with id ${id}.`);
    if (!run.open) throw new Error(`Claude agent "${run.name}" has ended and its process is closed. Start a new Claude agent instead.`);
    clearTimeout(run.idle);
    const was = run.busy;
    run.busy = true;
    run.stopping = null;
    this.host.tracker.followUp(id, text);
    run.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID() });
    return was ? 'queued' as const : 'started' as const;
  }

  // by says who asked, which decides whether the main agent hears of it.
  async stop(id: string, by: StopBy) {
    const run = this.runs.get(id);
    if (!run?.open) return false;
    run.stopping = by;
    try {
      await run.q.interrupt();
    } catch {}
    this.close(run);
    return true;
  }

  closeAll() {
    for (const r of this.runs.values()) void this.stop(r.id, 'session');
  }

  has(id: string) {
    return this.runs.has(id);
  }

  private close(run: Run) {
    clearTimeout(run.idle);
    run.queue.close();
    run.q.close();
  }

  private async consume(run: Run) {
    let text = '';
    try {
      for await (const m of run.q) {
        // A follow-up queued mid-turn can run as a turn of its own after the last result.
        if (m.type === 'assistant' && !run.busy && run.open) {
          clearTimeout(run.idle);
          run.busy = true;
          this.host.tracker.followUp(run.id, null);
        }
        this.host.tracker.feed(run.id, m);
        if (m.type === 'assistant' && !m.parent_tool_use_id) {
          const said = m.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
          if (said) text = said;
        } else if (m.type === 'result') {
          this.turnDone(run, m, text);
          text = '';
        }
      }
    } catch (e) {
      if (run.busy && !run.stopping) this.end(run, 'failed', `Claude Code stopped: ${oneLine(errText(e), 300)}`);
    } finally {
      run.open = false;
      clearTimeout(run.idle);
      if (run.busy) this.end(run, run.stopping ? 'stopped' : 'failed', run.stopping ? '' : 'Claude Code exited before it finished');
      this.host.tracker.settle(run.id, run.stopping ? 'stopped' : 'done', null, null, true);
      this.runs.delete(run.id);
    }
  }

  private turnDone(run: Run, m: Extract<SDKMessage, { type: 'result' }>, text: string) {
    const ok = m.subtype === 'success' && !m.is_error;
    const report = m.subtype === 'success' ? m.result || text : text;
    const error = ok ? null : m.subtype === 'success' ? 'it reported an error' : m.subtype.replace(/_/g, ' ');
    this.end(run, run.stopping ? 'stopped' : ok ? 'done' : 'failed', report, error);
    run.idleAt = Date.now();
    run.idle = setTimeout(() => this.close(run), IDLE_CLOSE_MS);
    run.idle.unref?.();
    this.trimIdle();
  }

  // Ends the row's turn and tells the main agent, unless it asked for the stop itself or the session is closing.
  private end(run: Run, state: 'done' | 'failed' | 'stopped', report: string, error: string | null = null) {
    if (!run.busy) return;
    run.busy = false;
    this.host.tracker.settle(run.id, state, report || error || null, null, false);
    if (run.stopping === 'agent' || run.stopping === 'session') return;
    const status = state === 'done' ? 'completed' : state === 'stopped' ? 'killed' : 'failed';
    const how = state === 'done' ? 'completed' : state === 'stopped' ? 'was stopped by the user' : `failed${error ? `: ${error}` : ''}`;
    const body = report.length > REPORT_MAX ? `${report.slice(0, REPORT_MAX)}\n[cut; the full report is in the agents panel]` : report;
    this.host.report([
      '<task-notification>',
      `<task-id>${run.id}</task-id>`,
      `<tool-use-id>${run.id}</tool-use-id>`,
      `<status>${status}</status>`,
      `<summary>Claude agent "${run.name}" (${modelLabel(run.model)}) ${how}</summary>`,
      ...(body ? [`<result>${body}</result>`] : []),
      '</task-notification>',
      `This is the result of Claude agent ${run.id}.${state === 'done' && run.open ? ' Send it a follow-up with mcp__app__claude_message if needed.' : ''}`,
    ].join('\n'));
  }

  // Idle processes past the cap close oldest first.
  private trimIdle() {
    const idle = [...this.runs.values()].filter((r) => r.open && !r.busy).sort((a, b) => b.idleAt - a.idleAt);
    for (const r of idle.slice(IDLE_MAX)) this.close(r);
  }
}
