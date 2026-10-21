import type { Mode } from '../protocol.ts';
import { codex, CodexError, type CodexClient, type ServerRequest } from './client.ts';
import type {
  AdditionalContext, ApprovalsReviewer, AskForApproval, CommandApprovalParams, FileChangeApprovalParams, LegacyExecApprovalParams, LegacyPatchApprovalParams,
  PermissionsApprovalParams, ReasoningEffort, RequestId, ReviewDecision, SandboxMode, SandboxPolicy, ThreadItem, ThreadStatus, ThreadTokenUsage,
  Turn, TurnError, TurnPlanStep, TurnStartParams, UserInput,
} from './types.ts';

export type CodexPolicy = { approvalPolicy: AskForApproval; approvalsReviewer: ApprovalsReviewer; sandbox: SandboxMode; sandboxPolicy: SandboxPolicy };

// t3code's table. Plan has no Codex sandbox of its own, so it runs read-only like default.
export function codexPolicy(mode: Mode): CodexPolicy {
  const workspace: SandboxPolicy = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  switch (mode) {
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', sandboxPolicy: workspace };
    case 'auto':
      return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: workspace };
    case 'bypassPermissions':
      return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    default:
      return { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
  }
}

// Codex's own subagents run as child threads the app never sees, so their approvals had no tab to ask; codex_agent replaces them.
export const NATIVE_AGENTS_OFF = { 'features.multi_agent': false, 'features.multi_agent_v2': false };
// A project's CLAUDE.md is read where it has no AGENTS.md.
export const CLAUDE_DOCS = { project_doc_fallback_filenames: ['CLAUDE.md'] };

export type CodexEvent =
  | { type: 'turn-started' | 'turn-completed'; turn: Turn }
  | { type: 'message-delta'; turnId: string; itemId: string; delta: string }
  | { type: 'reasoning-delta'; turnId: string; itemId: string; delta: string }
  | { type: 'output-delta'; turnId: string; itemId: string; delta: string }
  | { type: 'item-started' | 'item-completed'; turnId: string; item: ThreadItem; at: number }
  | { type: 'plan'; turnId: string; explanation: string | null; plan: TurnPlanStep[] }
  | { type: 'tokens'; turnId: string; usage: ThreadTokenUsage }
  | { type: 'error'; turnId: string; error: TurnError; willRetry: boolean }
  | { type: 'status'; status: ThreadStatus }
  // Codex settled a request itself (turn interrupted, another client answered).
  | { type: 'request-resolved'; requestId: RequestId }
  | { type: 'mcp-status'; name: string; status: McpStartup['status']; error: string | null }
  | { type: 'closed'; reason: string };

export type McpStartup = { status: 'starting' | 'ready' | 'failed' | 'cancelled'; error: string | null };
const MCP_STATUS = 'mcpServer/startupStatus/updated';
// A startup report can arrive before thread/start answers, so it waits here for its thread.
const EARLY_MAX = 16;
const early = new Map<string, Record<string, unknown>[]>();

type ApprovalBase = { threadId: string; turnId: string; itemId: string; reason: string | null; signal: AbortSignal };
export type CodexApproval =
  | (ApprovalBase & { kind: 'command'; command: string | null; cwd: string | null })
  | (ApprovalBase & { kind: 'fileChange'; grantRoot: string | null })
  | (ApprovalBase & { kind: 'permissions'; cwd: string; permissions: unknown });
type Ask = CodexApproval extends infer A ? (A extends unknown ? Omit<A, 'signal'> : never) : never;
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
// signal aborts when Codex no longer waits for the answer; the answer is then dropped.
export type ApprovalHandler = (a: CodexApproval) => Promise<ApprovalDecision>;

// policy overrides the one mode maps to (image generation runs read-only with no approvals).
export type ThreadOptions = {
  cwd: string; model?: string; effort?: ReasoningEffort; mode: Mode; developerInstructions?: string; ephemeral?: boolean; policy?: CodexPolicy;
  config?: Record<string, unknown>; baseInstructions?: string; serviceTier?: string;
};
export type TurnOptions = { model?: string; effort?: ReasoningEffort; mode?: Mode; additionalContext?: AdditionalContext; summary?: TurnStartParams['summary'] };

const KNOWN_ITEMS = new Set([
  'userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageView',
  'imageGeneration', 'contextCompaction',
]);
export const toItem = (raw: unknown): ThreadItem => {
  const r = (raw ?? {}) as { type?: unknown; id?: unknown };
  return typeof r.type === 'string' && KNOWN_ITEMS.has(r.type) ? (raw as ThreadItem) : { type: 'other', id: String(r.id ?? ''), kind: String(r.type ?? 'unknown') };
};

const inputOf = (input: string | UserInput[]): UserInput[] => (typeof input === 'string' ? [{ type: 'text', text: input, text_elements: [] }] : input);

const threads = new Map<string, CodexThread>();

export class CodexThread {
  readonly id: string;
  readonly cwd: string;
  model: string;
  effort: ReasoningEffort | null;
  mode: Mode;
  turnId: string | null = null;
  closed = false;
  // Each MCP server's latest startup state, so a listener that subscribed late still sees a failure.
  readonly mcp = new Map<string, McpStartup>();
  private listeners = new Set<(e: CodexEvent) => void>();
  private approver: ApprovalHandler | null = null;
  // One per open approval, so Codex settling it or the thread ending stops the wait.
  private asks = new Map<RequestId, AbortController>();
  private release: () => void;
  // The app-server this thread lives on: the shared one, or the board's own.
  readonly client: CodexClient;

  constructor(id: string, cwd: string, model: string, effort: ReasoningEffort | null, mode: Mode, release: () => void, client: CodexClient = codex) {
    this.id = id;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.mode = mode;
    this.release = release;
    this.client = client;
  }

  subscribe(fn: (e: CodexEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  // Without a handler every approval is declined.
  onApproval(fn: ApprovalHandler | null) {
    this.approver = fn;
  }

  // Policy goes out whenever a mode is passed (approvalsReviewer is sticky, so it is restated); model and effort go out on every turn.
  async startTurn(input: string | UserInput[], opts: TurnOptions = {}): Promise<Turn> {
    if (this.closed) throw new CodexError('This Codex thread is closed');
    if (opts.model) this.model = opts.model;
    if (opts.effort) this.effort = opts.effort;
    const policy = opts.mode ? codexPolicy(opts.mode) : null;
    const { turn } = await this.client.request('turn/start', {
      threadId: this.id,
      input: inputOf(input),
      model: this.model,
      effort: this.effort,
      summary: opts.summary ?? 'detailed',
      ...(policy && { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandboxPolicy: policy.sandboxPolicy }),
      ...(opts.additionalContext && { additionalContext: opts.additionalContext }),
    });
    if (opts.mode) this.mode = opts.mode;
    this.turnId = turn.id;
    return turn;
  }

  // Adds input to the running turn; false when no turn runs, so the caller starts one instead. Throws when Codex refuses it.
  async steer(input: string | UserInput[]): Promise<boolean> {
    if (this.closed || !this.turnId) return false;
    await this.client.request('turn/steer', { threadId: this.id, input: inputOf(input), expectedTurnId: this.turnId });
    return true;
  }

  // Appends raw Responses API items to the model's history (instructions lost to a compaction).
  async inject(items: unknown[]) {
    if (this.closed) return;
    await this.client.request('thread/inject_items', { threadId: this.id, items }, 10_000);
  }

  async setName(name: string) {
    if (this.closed) return;
    await this.client.request('thread/name/set', { threadId: this.id, name });
  }

  async interrupt(timeoutMs?: number) {
    if (this.closed || !this.turnId) return;
    await this.client.request('turn/interrupt', { threadId: this.id, turnId: this.turnId }, timeoutMs);
  }

  async close(timeoutMs?: number) {
    if (this.closed) return;
    try {
      if (this.client.running) await this.client.request('thread/unsubscribe', { threadId: this.id }, timeoutMs);
    } catch {}
    this.end('closed');
  }

  // The rest is called by the module's router.
  end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    threads.delete(this.id);
    for (const c of this.asks.values()) c.abort();
    this.asks.clear();
    this.emit({ type: 'closed', reason });
    this.listeners.clear();
    this.release();
  }

  async approval(requestId: RequestId, a: Ask): Promise<ApprovalDecision> {
    const approver = this.approver;
    if (!approver || this.closed) return 'decline';
    const ctl = new AbortController();
    this.asks.set(requestId, ctl);
    const aborted = new Promise<ApprovalDecision>((done) => ctl.signal.addEventListener('abort', () => done('cancel'), { once: true }));
    try {
      return await Promise.race([approver({ ...a, signal: ctl.signal } as CodexApproval), aborted]);
    } catch {
      return 'cancel';
    } finally {
      this.asks.delete(requestId);
    }
  }

  handle(method: string, p: Record<string, unknown>) {
    const turnId = typeof p.turnId === 'string' ? p.turnId : '';
    switch (method) {
      case 'turn/started':
        this.turnId = (p.turn as Turn).id;
        return this.emit({ type: 'turn-started', turn: p.turn as Turn });
      case 'turn/completed':
        if (this.turnId === (p.turn as Turn).id) this.turnId = null;
        return this.emit({ type: 'turn-completed', turn: p.turn as Turn });
      case 'item/agentMessage/delta':
        return this.emit({ type: 'message-delta', turnId, itemId: String(p.itemId), delta: String(p.delta) });
      case 'item/reasoning/summaryTextDelta':
        return this.emit({ type: 'reasoning-delta', turnId, itemId: String(p.itemId), delta: String(p.delta) });
      case 'item/commandExecution/outputDelta':
        return this.emit({ type: 'output-delta', turnId, itemId: String(p.itemId), delta: String(p.delta) });
      case 'item/started':
        return this.emit({ type: 'item-started', turnId, item: toItem(p.item), at: Number(p.startedAtMs) || Date.now() });
      case 'item/completed':
        return this.emit({ type: 'item-completed', turnId, item: toItem(p.item), at: Number(p.completedAtMs) || Date.now() });
      case 'turn/plan/updated':
        return this.emit({ type: 'plan', turnId, explanation: (p.explanation as string | null) ?? null, plan: (p.plan as TurnPlanStep[]) ?? [] });
      case 'thread/tokenUsage/updated':
        return this.emit({ type: 'tokens', turnId, usage: p.tokenUsage as ThreadTokenUsage });
      case 'error':
        return this.emit({ type: 'error', turnId, error: p.error as TurnError, willRetry: p.willRetry === true });
      case 'thread/status/changed':
        return this.emit({ type: 'status', status: p.status as ThreadStatus });
      case 'serverRequest/resolved': {
        const id = p.requestId as RequestId;
        this.asks.get(id)?.abort();
        return this.emit({ type: 'request-resolved', requestId: id });
      }
      case MCP_STATUS: {
        const name = String(p.name);
        const s: McpStartup = { status: p.status as McpStartup['status'], error: typeof p.error === 'string' ? p.error : null };
        this.mcp.set(name, s);
        return this.emit({ type: 'mcp-status', name, ...s });
      }
      case 'thread/closed':
        return this.end('Codex closed the thread');
    }
  }

  private emit(e: CodexEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error('[codex] thread listener failed', err);
      }
    }
  }
}

function register(t: CodexThread) {
  threads.set(t.id, t);
  for (const p of early.get(t.id) ?? []) t.handle(MCP_STATUS, p);
  early.delete(t.id);
}

export async function startThread(o: ThreadOptions & { client?: CodexClient }): Promise<CodexThread> {
  const client = o.client ?? codex;
  const release = client.hold();
  try {
    const p = o.policy ?? codexPolicy(o.mode);
    const r = await client.request('thread/start', {
      cwd: o.cwd,
      model: o.model ?? null,
      approvalPolicy: p.approvalPolicy,
      approvalsReviewer: p.approvalsReviewer,
      sandbox: p.sandbox,
      developerInstructions: o.developerInstructions ?? null,
      ephemeral: o.ephemeral ?? null,
      ...(o.config && { config: o.config }),
      ...(o.baseInstructions && { baseInstructions: o.baseInstructions }),
      ...(o.serviceTier && { serviceTier: o.serviceTier }),
    }, 120_000);
    const t = new CodexThread(r.thread.id, r.cwd, r.model, o.effort ?? r.reasoningEffort, o.mode, release, client);
    register(t);
    return t;
  } catch (e) {
    release();
    throw e;
  }
}

// Loads a saved thread again (after the app-server restarted), without sending its old turns back.
export async function resumeThread(threadId: string, o: ThreadOptions): Promise<CodexThread> {
  const release = codex.hold();
  try {
    const p = o.policy ?? codexPolicy(o.mode);
    const r = await codex.request('thread/resume', {
      threadId, cwd: o.cwd, model: o.model ?? null, approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandbox: p.sandbox,
      excludeTurns: true, ...(o.config && { config: o.config }),
    }, 120_000);
    const t = new CodexThread(r.thread.id, r.cwd, r.model, o.effort ?? r.reasoningEffort, o.mode, release);
    register(t);
    return t;
  } catch (e) {
    release();
    throw e;
  }
}

// A copy of a saved thread's history as a new thread; the source is left as it is. ephemeral says whether Codex kept it off disk.
export async function forkThread(threadId: string, o: ThreadOptions): Promise<{ thread: CodexThread; ephemeral: boolean }> {
  const release = codex.hold();
  try {
    const p = o.policy ?? codexPolicy(o.mode);
    const r = await codex.request('thread/fork', {
      threadId, cwd: o.cwd, model: o.model ?? null, approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandbox: p.sandbox,
      developerInstructions: o.developerInstructions ?? null, excludeTurns: true, ...(o.ephemeral !== undefined && { ephemeral: o.ephemeral }), ...(o.config && { config: o.config }),
    }, 120_000);
    const t = new CodexThread(r.thread.id, r.cwd, r.model, o.effort ?? r.reasoningEffort, o.mode, release);
    register(t);
    return { thread: t, ephemeral: r.thread.ephemeral === true };
  } catch (e) {
    release();
    throw e;
  }
}

export const liveThread = (id: string) => threads.get(id);

// Saved threads, loaded or not; these never start a turn.
export const readThread = async (threadId: string) => (await codex.request('thread/read', { threadId, includeTurns: false })).thread;
export const setThreadName = (threadId: string, name: string) => codex.request('thread/name/set', { threadId, name });
export const archiveThread = (threadId: string) => codex.request('thread/archive', { threadId });
export const unarchiveThread = (threadId: string) => codex.request('thread/unarchive', { threadId });

// Delete forever: Codex removes the thread and its rollout under ~/.codex.
export const deleteThread = (threadId: string, client: CodexClient = codex) => client.request('thread/delete', { threadId });

const permissionsReply = (d: ApprovalDecision, asked: PermissionsApprovalParams['permissions']) => {
  const granted = Object.fromEntries(Object.entries(asked ?? {}).filter(([, v]) => v != null));
  return d === 'accept' || d === 'acceptForSession' ? { permissions: granted, scope: d === 'accept' ? 'turn' : 'session' } : { permissions: {}, scope: 'turn' };
};
const legacyDecision = (d: ApprovalDecision): ReviewDecision =>
  d === 'accept' ? 'approved' : d === 'acceptForSession' ? 'approved_for_session' : d === 'decline' ? { denied: { rejection: 'Declined by the user' } } : 'abort';

async function decide(threadId: string, requestId: RequestId, a: Ask): Promise<ApprovalDecision> {
  const t = threads.get(threadId);
  if (!t) console.warn(`[codex] ${a.kind} approval from unknown thread ${threadId} declined`);
  return t ? t.approval(requestId, a) : 'decline';
}

// Server-to-client requests: approvals go to their thread; the rest is refused until a later stage needs it.
async function route(req: ServerRequest): Promise<unknown> {
  switch (req.method) {
    case 'item/commandExecution/requestApproval': {
      const p = req.params as CommandApprovalParams;
      const base = { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, reason: p.reason ?? null };
      return { decision: await decide(p.threadId, req.id, { ...base, kind: 'command', command: p.command ?? null, cwd: p.cwd ?? null }) };
    }
    case 'item/fileChange/requestApproval': {
      const p = req.params as FileChangeApprovalParams;
      const base = { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, reason: p.reason ?? null };
      return { decision: await decide(p.threadId, req.id, { ...base, kind: 'fileChange', grantRoot: p.grantRoot ?? null }) };
    }
    case 'item/permissions/requestApproval': {
      const p = req.params as PermissionsApprovalParams;
      const base = { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, reason: p.reason ?? null };
      return permissionsReply(await decide(p.threadId, req.id, { ...base, kind: 'permissions', cwd: p.cwd, permissions: p.permissions }), p.permissions);
    }
    case 'execCommandApproval': {
      const p = req.params as LegacyExecApprovalParams;
      const base = { threadId: p.conversationId, turnId: '', itemId: p.callId, reason: p.reason };
      return { decision: legacyDecision(await decide(p.conversationId, req.id, { ...base, kind: 'command', command: p.command.join(' '), cwd: p.cwd })) };
    }
    case 'applyPatchApproval': {
      const p = req.params as LegacyPatchApprovalParams;
      const base = { threadId: p.conversationId, turnId: '', itemId: p.callId, reason: p.reason };
      return { decision: legacyDecision(await decide(p.conversationId, req.id, { ...base, kind: 'fileChange', grantRoot: p.grantRoot })) };
    }
    case 'mcpServer/elicitation/request':
      console.warn(`[codex] MCP elicitation from ${String((req.params as { serverName?: unknown }).serverName)} cancelled`);
      return { action: 'cancel', content: null, _meta: null };
  }
  throw new CodexError(`tarcsweb does not handle ${req.method}`, -32601);
}

// Routes an app-server's approvals and events to its threads; called once per client.
export function attachClient(client: CodexClient) {
  client.setRequestHandler(route);
  client.onNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const t = typeof p.threadId === 'string' ? threads.get(p.threadId) : undefined;
    if (t?.client === client) t.handle(method, p);
    else if (!t && method === MCP_STATUS && typeof p.threadId === 'string') {
      early.set(p.threadId, [...(early.get(p.threadId) ?? []), p].slice(-EARLY_MAX));
      if (early.size > EARLY_MAX) early.delete(early.keys().next().value!);
    }
  });
  client.onExit((reason) => {
    for (const t of [...threads.values()]) if (t.client === client) t.end(reason);
  });
}

attachClient(codex);
