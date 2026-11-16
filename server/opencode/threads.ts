import { setTimeout as delay } from 'node:timers/promises';
import type { Mode } from '../protocol.ts';
import { opencode, OpencodeError, type FormAnswer, type FormInfo, type ModelRef, type OpencodeEvent, type PermissionRequest, type PromptRequest, type Ruleset, type SessionInfo } from './client.ts';
import { OPENCODE_PREFIX } from './types.ts';

export type ThreadOptions = {
  cwd: string; model: string; effort?: string; mode: Mode; instructions?: string;
  // name is the allow-rule prefix; servers, when given, are registered instead of {name, url} and must start with `${name}_`.
  mcp?: { name: string; url: string; authorization: string; servers?: { name: string; url: string }[] }; subagents?: boolean;
  // Saved on a new session only, e.g. a marker that lists it as this app's.
  metadata?: Record<string, unknown>;
};
export type Attachment = NonNullable<PromptRequest['files']>[number];
export type ApprovalDecision = 'once' | 'always' | 'reject';
export type ApprovalResult = ApprovalDecision | { decision: ApprovalDecision; message?: string };
export type ApprovalHandler = (request: PermissionRequest & { signal: AbortSignal }) => Promise<ApprovalResult>;
export type FormHandler = (form: FormInfo & { signal: AbortSignal }) => Promise<FormAnswer | null>;
export type Edit = { path: string; before?: string; after?: string; patch?: string };
export type Tool = {
  id: string; name: string; input: Record<string, unknown> | string; output?: unknown;
  status: 'streaming' | 'running' | 'completed' | 'failed'; startedAt: number; durationMs: number;
  metadata?: Record<string, unknown>; error?: string; edits?: Edit[];
};
type EventBase = { sessionID: string; turnId: string };
export type OpencodeThreadEvent = EventBase & (
  | { type: 'turn-started' }
  | { type: 'turn-ended'; status: 'succeeded' | 'failed' | 'interrupted'; error: string | null }
  | { type: 'message-delta' | 'reasoning-delta'; itemId: string; delta: string }
  | { type: 'message-final'; itemId: string; text: string }
  | { type: 'tool-start' | 'tool-update' | 'tool-end'; tool: Tool }
  | { type: 'plan'; todos: { content: string; status: string }[] }
  | { type: 'tokens'; usage: Record<string, unknown>; contextWindow: number | null; cumulative: boolean; cost?: number }
  | { type: 'child-started'; parentID: string }
  | { type: 'child-ended'; status: 'succeeded' | 'failed' | 'interrupted'; error: string | null }
  | { type: 'raw'; event: OpencodeEvent }
  | { type: 'connection'; connected: boolean; error: string | null }
  | { type: 'error'; error: string }
  | { type: 'closed' }
);

const roots = new Map<string, OpencodeThread>();
const owners = new Map<string, OpencodeThread>();
const frames = new Set<(frame: string) => void>();
let users = 0;
let stream: Promise<void> | null = null;
let controller: AbortController | null = null;
let connected = false;
const waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();

export function subscribeOpencodeFrames(fn: (frame: string) => void) {
  frames.add(fn);
  return () => void frames.delete(fn);
}

async function acquireStream() {
  users++;
  if (controller?.signal.aborted) await stream;
  if (!stream) {
    const ctl = new AbortController();
    controller = ctl;
    stream = runStream(ctl.signal).finally(() => { stream = null; connected = false; });
  }
  if (!connected) {
    try { await new Promise<void>((resolve, reject) => waiters.add({ resolve, reject })); }
    catch (error) { users--; throw error; }
  }
}

async function releaseStream() {
  if (--users > 0) return;
  controller?.abort();
  await stream;
}

async function runStream(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      for await (const event of opencode.subscribe({ signal, onFrame: (frame) => { for (const fn of frames) fn(frame); } })) {
        if (event.type === 'server.connected') {
          connected = true;
          for (const waiter of waiters) waiter.resolve();
          waiters.clear();
          for (const thread of roots.values()) {
            thread.connection(true, null);
            void thread.reconcile().catch((error: unknown) => thread.reportError(error));
          }
          continue;
        }
        const data = event.type === 'form.created' ? object(event.data.form) : event.data;
        const id = typeof data.sessionID === 'string' ? data.sessionID : '';
        if (event.type === 'session.created' && typeof data.parentID === 'string') owners.get(data.parentID)?.addChild(id, data.parentID);
        const owner = owners.get(id);
        if (owner) owner.handle(event, id);
        else if (!id) for (const thread of roots.values()) {
          if (!event.location || event.location.directory === thread.cwd) thread.handle(event, thread.id);
        }
      }
    } catch (error) {
      connected = false;
      if (signal.aborted) break;
      if (!roots.size && waiters.size) {
        for (const waiter of waiters) waiter.reject(error);
        waiters.clear();
        break;
      }
      for (const thread of roots.values()) thread.connection(false, errorText(error));
      await delay(1000, undefined, { signal }).catch(() => {});
    }
  }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const mcpServers = (mcp: ThreadOptions['mcp']) => !mcp ? [] : mcp.servers ?? [{ name: mcp.name, url: mcp.url }];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function modelRef(model: string, effort?: string): ModelRef {
  if (!model.startsWith(OPENCODE_PREFIX)) throw new Error('OpenCode model IDs must start with opencode:');
  const value = model.slice(OPENCODE_PREFIX.length);
  const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new Error('OpenCode model IDs must include provider/model');
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1), ...(effort ? { variant: effort } : {}) };
}

export function opencodeRules(mode: Mode, subagents = false, mcpName?: string): Ruleset {
  const rules: Ruleset = mode === 'auto' || mode === 'bypassPermissions'
    ? [{ action: '*', resource: '*', effect: 'allow' }]
    : [
        { action: 'shell', resource: '*', effect: 'ask' },
        { action: 'edit', resource: '*', effect: mode === 'plan' ? 'deny' : mode === 'acceptEdits' ? 'allow' : 'ask' },
        { action: 'external_directory', resource: '*', effect: 'ask' },
      ];
  rules.push({ action: 'subagent', resource: '*', effect: subagents ? 'allow' : 'deny' });
  rules.push({ action: 'tarcsweb_*', resource: '*', effect: 'deny' });
  if (mcpName) rules.push({ action: `${mcpName}_*`, resource: '*', effect: 'allow' });
  return rules;
}

type Execution = { id: string; startedAt: number };

export class OpencodeThread {
  readonly id: string;
  readonly cwd: string;
  model: string;
  effort: string | null;
  mode: Mode;
  closed = false;
  private options: ThreadOptions;
  private listeners = new Set<(event: OpencodeThreadEvent) => void>();
  private approver: ApprovalHandler | null = null;
  private formHandler: FormHandler | null = null;
  private executions = new Map<string, Execution>();
  private executionRevisions = new Map<string, number>();
  // Only active tool calls and requests are retained; terminal events remove them.
  private tools = new Map<string, Tool>();
  private asks = new Map<string, AbortController>();
  private forms = new Map<string, AbortController>();
  private pendingPermissions = new Map<string, PermissionRequest>();
  private pendingForms = new Map<string, FormInfo>();
  private children = new Set<string>();
  private window: number | null = null;
  private modelWindows = new Map<string, number>();
  private sessionWindows = new Map<string, number | null>();
  private mcpRegistration: Promise<void> | null = null;

  private constructor(info: SessionInfo, options: ThreadOptions) {
    this.id = info.id;
    this.cwd = options.cwd;
    this.model = options.model;
    this.effort = options.effort ?? null;
    this.mode = options.mode;
    this.options = options;
  }

  static async start(options: ThreadOptions) {
    const model = modelRef(options.model, options.effort);
    await acquireStream();
    let thread: OpencodeThread | undefined;
    try {
      const { data } = await opencode.createSession({ location: { directory: options.cwd }, model, agent: options.mode === 'plan' ? 'plan' : 'build', permissions: opencodeRules(options.mode, options.subagents, options.mcp?.name), ...(options.metadata ? { metadata: options.metadata } : {}) });
      thread = new OpencodeThread(data, options);
      roots.set(thread.id, thread);
      owners.set(thread.id, thread);
      await thread.configure();
      return thread;
    } catch (error) {
      if (thread) await thread.close();
      else await releaseStream();
      throw error;
    }
  }

  static async resume(sessionID: string, options?: Partial<ThreadOptions>) {
    const { data } = await opencode.getSession(sessionID);
    if (owners.has(sessionID)) throw new Error('This OpenCode session is already open');
    const model = options?.model ?? (data.model ? `${OPENCODE_PREFIX}${data.model.providerID}/${data.model.id}` : null);
    if (!model) throw new Error('The saved OpenCode session has no selected model');
    const mode = options?.mode ?? (data.agent === 'plan' ? 'plan' : data.permissions?.some(r => r.action === '*' && r.effect === 'allow') ? 'bypassPermissions' : data.permissions?.some(r => r.action === 'edit' && r.effect === 'allow') ? 'acceptEdits' : 'default');
    const opts: ThreadOptions = { ...options, cwd: options?.cwd ?? data.location.directory, model, effort: options?.effort ?? data.model?.variant, mode, subagents: options?.subagents ?? (data.permissions?.findLast(rule => rule.action === 'subagent')?.effect === 'allow') };
    if (opts.cwd !== data.location.directory) throw new Error('Resume must use the saved session directory');
    modelRef(model, opts.effort);
    await acquireStream();
    const thread = new OpencodeThread(data, opts);
    roots.set(sessionID, thread);
    owners.set(sessionID, thread);
    try {
      await thread.setModel(model, opts.effort);
      await thread.setMode(mode);
      await thread.configure();
      await thread.reconcile();
      return thread;
    } catch (error) { await thread.close(); throw error; }
  }

  get turnId() { return this.executions.get(this.id)?.id ?? null; }

  subscribe(fn: (event: OpencodeThreadEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  onApproval(fn: ApprovalHandler | null) {
    this.approver = fn;
    if (fn) for (const request of this.pendingPermissions.values()) void this.approve(request).catch(error => this.reportError(error));
  }
  onForm(fn: FormHandler | null) {
    this.formHandler = fn;
    if (fn) for (const form of this.pendingForms.values()) void this.answer(form).catch(error => this.reportError(error));
  }

  async startTurn(text: string, attachments?: Attachment[]) {
    this.assertOpen();
    return (await opencode.prompt(this.id, { text, ...(attachments?.length ? { files: attachments } : {}) })).data;
  }

  async steer(text: string) {
    if (this.closed) return false;
    if (!this.turnId || !connected) {
      const active = await opencode.activeSessions();
      if (!active.data[this.id]) return false;
    }
    await opencode.prompt(this.id, { text, delivery: 'steer' });
    return true;
  }

  async interrupt() {
    if (this.closed) return;
    await Promise.all([this.id, ...this.children].map(id => opencode.interrupt(id)));
  }

  async setMode(mode: Mode) {
    this.assertOpen();
    await opencode.setAgent(this.id, mode === 'plan' ? 'plan' : 'build');
    await opencode.updateSession(this.id, { permissions: opencodeRules(mode, this.options.subagents, this.options.mcp?.name) });
    this.mode = mode;
  }

  async setModel(model: string, effort?: string) {
    this.assertOpen();
    const ref = modelRef(model, effort);
    await opencode.setModel(this.id, ref);
    this.model = model;
    this.effort = effort ?? null;
    await this.loadWindow();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.mcpRegistration?.catch(error => this.reportError(error));
      const cleanup = await Promise.allSettled([
        ...[...this.executions.keys()].map(id => opencode.interrupt(id)),
        ...mcpServers(this.options.mcp).map(s => opencode.deleteMcp(s.name, { directory: this.cwd }).catch(error => {
          if (!(error instanceof OpencodeError && error.status === 404)) throw error;
        })),
      ]);
      const failed = cleanup.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } finally {
      roots.delete(this.id);
      owners.delete(this.id);
      for (const id of this.children) owners.delete(id);
      for (const ask of [...this.asks.values(), ...this.forms.values()]) ask.abort();
      this.asks.clear(); this.forms.clear(); this.pendingPermissions.clear(); this.pendingForms.clear(); this.tools.clear(); this.executions.clear(); this.children.clear();
      this.modelWindows.clear(); this.sessionWindows.clear();
      this.executionRevisions.clear();
      this.emit({ type: 'closed', sessionID: this.id, turnId: '' });
      this.listeners.clear();
      await releaseStream();
    }
  }

  private assertOpen() { if (this.closed) throw new Error('This OpenCode thread is closed'); }

  private async configure() {
    if (this.options.instructions !== undefined) await opencode.putInstruction(this.id, 'tarcsweb', this.options.instructions);
    await this.registerMcp();
    await this.loadWindow();
  }

  private async registerMcp() {
    const mcp = this.options.mcp;
    if (!mcp || this.closed) return;
    this.mcpRegistration ??= Promise.all(mcpServers(mcp).map(s => opencode.putMcp(s.name, { type: 'remote', url: s.url, headers: { Authorization: mcp.authorization }, oauth: false }, { directory: this.cwd }))).then(() => {}).finally(() => { this.mcpRegistration = null; });
    await this.mcpRegistration;
  }

  private async loadWindow() {
    const ref = modelRef(this.model);
    const { data } = await opencode.models({ directory: this.cwd });
    this.modelWindows = new Map(data.map(m => [`${m.providerID}/${m.id}`, m.limit.input ?? m.limit.context]));
    const model = data.find(m => m.providerID === ref.providerID && m.id === ref.id);
    this.window = model ? model.limit.input ?? model.limit.context : null;
  }

  addChild(id: string, parentID: string) {
    if (this.closed || this.children.has(id)) return;
    // Completed child ownership is trimmed after 256 entries; active children keep their routing.
    if (this.children.size >= 256) {
      const finished = [...this.children].find(child => !this.executions.has(child));
      if (finished) { this.children.delete(finished); owners.delete(finished); this.executionRevisions.delete(finished); }
    }
    this.children.add(id);
    owners.set(id, this);
    this.emit({ type: 'child-started', sessionID: id, parentID, turnId: '' });
  }

  connection(isConnected: boolean, error: string | null) {
    this.emit({ type: 'connection', sessionID: this.id, turnId: this.turnId ?? '', connected: isConnected, error });
  }

  reportError(error: unknown) {
    this.emit({ type: 'error', sessionID: this.id, turnId: this.turnId ?? '', error: errorText(error) });
  }

  async reconcile() {
    if (this.closed) return;
    await this.registerMcp();
    // A child can be created while the stream is disconnected, before its first ask.
    const parents = [this.id];
    for (let i = 0; i < parents.length; i++) {
      let cursor: string | undefined;
      do {
        const children = await opencode.listSessions({ parentID: parents[i], limit: 200, cursor });
        if (this.closed) return;
        for (const child of children.data) {
          this.addChild(child.id, parents[i]);
          parents.push(child.id);
        }
        cursor = children.cursor.next;
      } while (cursor);
    }
    const revisions = new Map(this.executionRevisions);
    const active = await opencode.activeSessions();
    for (const id of [this.id, ...this.children]) {
      if (this.closed) return;
      const unchanged = () => (this.executionRevisions.get(id) ?? 0) === (revisions.get(id) ?? 0);
      if (unchanged() && active.data[id] && !this.executions.has(id)) {
        this.executions.set(id, { id: `${id}:recovered`, startedAt: Date.now() });
        this.emit({ type: 'turn-started', sessionID: id, turnId: `${id}:recovered` });
      } else if (unchanged() && !active.data[id] && this.executions.has(id)) {
        const session = (await opencode.getSession(id)).data;
        if (unchanged() && session.outcome) {
          const idle = (await opencode.listMessages(id, { type: 'idle', order: 'desc', limit: 1 })).data[0];
          if (unchanged()) this.handle({ type: `session.execution.${session.outcome}`, data: { sessionID: id, error: idle?.error }, created: session.time.updated }, id);
        }
      }
      const [permissions, forms] = await Promise.all([opencode.listPermissions(id), opencode.listForms(id)]);
      for (const [key, ask] of this.asks) if (key.startsWith(`${id}:`) && !permissions.data.some(p => key === `${id}:${p.id}`)) ask.abort();
      for (const [key, form] of this.forms) if (key.startsWith(`${id}:`) && !forms.data.some(f => key === `${id}:${f.id}`)) form.abort();
      for (const key of this.pendingPermissions.keys()) if (key.startsWith(`${id}:`) && !permissions.data.some(p => key === `${id}:${p.id}`)) this.pendingPermissions.delete(key);
      for (const key of this.pendingForms.keys()) if (key.startsWith(`${id}:`) && !forms.data.some(f => key === `${id}:${f.id}`)) this.pendingForms.delete(key);
      for (const request of permissions.data) void this.approve(request).catch(error => this.reportError(error));
      for (const form of forms.data) void this.answer(form).catch(error => this.reportError(error));
    }
  }

  private async approve(request: PermissionRequest) {
    const key = `${request.sessionID}:${request.id}`;
    if (this.closed || this.asks.has(key)) return;
    if (!this.approver) { this.pendingPermissions.set(key, request); return; }
    this.pendingPermissions.delete(key);
    const ctl = new AbortController();
    this.asks.set(key, ctl);
    try {
      const result = await Promise.race([
        this.approver?.({ ...request, signal: ctl.signal }) ?? Promise.resolve('reject' as const),
        new Promise<null>(resolve => ctl.signal.addEventListener('abort', () => resolve(null), { once: true })),
      ]);
      if (!result || ctl.signal.aborted) return;
      const reply = typeof result === 'string' ? { decision: result } : result;
      await opencode.replyPermission(request.sessionID, request.id, reply.decision, reply.message);
    } catch (error) {
      if (!ctl.signal.aborted) {
        await opencode.replyPermission(request.sessionID, request.id, 'reject', 'The approval handler failed.');
        throw error;
      }
    } finally { if (this.asks.get(key) === ctl) this.asks.delete(key); }
  }

  private async answer(form: FormInfo) {
    const key = `${form.sessionID}:${form.id}`;
    if (this.closed || this.forms.has(key)) return;
    const supported = form.fields.every(f => (f.type === 'string' || f.type === 'multiselect') && !f.hidden && !f.when);
    if (supported && !this.formHandler) { this.pendingForms.set(key, form); return; }
    this.pendingForms.delete(key);
    const ctl = new AbortController();
    this.forms.set(key, ctl);
    try {
      if (!supported || !this.formHandler) {
        await opencode.cancelForm(form.sessionID, form.id, supported ? 'No form handler is available. Continue without an answer.' : 'This form contains unsupported fields. Continue without an answer.');
        return;
      }
      const answer = await Promise.race([
        this.formHandler({ ...form, signal: ctl.signal }),
        new Promise<null>(resolve => ctl.signal.addEventListener('abort', () => resolve(null), { once: true })),
      ]);
      if (ctl.signal.aborted) return;
      if (answer) await opencode.replyForm(form.sessionID, form.id, answer);
      else await opencode.cancelForm(form.sessionID, form.id, 'The user dismissed this form. Continue without an answer.');
    } catch (error) {
      if (!ctl.signal.aborted) {
        await opencode.cancelForm(form.sessionID, form.id, 'The form handler failed. Continue without an answer.');
        throw error;
      }
    } finally { if (this.forms.get(key) === ctl) this.forms.delete(key); }
  }

  handle(event: OpencodeEvent, sessionID: string) {
    if (this.closed) return;
    const data = event.data;
    const base = { sessionID, turnId: this.executions.get(sessionID)?.id ?? '' };
    const itemId = `${data.assistantMessageID ?? ''}:${data.ordinal ?? ''}`;
    if (event.type === 'session.step.started' || event.type === 'session.model.selected') {
      const model = object(data.model);
      this.sessionWindows.set(sessionID, this.modelWindows.get(`${model.providerID}/${model.id}`) ?? null);
    }
    switch (event.type) {
      case 'session.execution.started': {
        this.executionRevisions.set(sessionID, (this.executionRevisions.get(sessionID) ?? 0) + 1);
        const id = event.id ?? `${sessionID}:${event.created ?? Date.now()}`;
        this.executions.set(sessionID, { id, startedAt: event.created ?? Date.now() });
        this.emit({ ...base, turnId: id, type: 'turn-started' });
        return;
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        this.executionRevisions.set(sessionID, (this.executionRevisions.get(sessionID) ?? 0) + 1);
        const status = event.type.slice('session.execution.'.length) as 'succeeded' | 'failed' | 'interrupted';
        const error = typeof object(data.error).message === 'string' ? String(object(data.error).message) : null;
        this.executions.delete(sessionID);
        this.sessionWindows.delete(sessionID);
        for (const key of this.tools.keys()) if (key.startsWith(`${sessionID}:`)) this.tools.delete(key);
        for (const [key, ctl] of [...this.asks, ...this.forms]) if (key.startsWith(`${sessionID}:`)) ctl.abort();
        for (const key of this.pendingPermissions.keys()) if (key.startsWith(`${sessionID}:`)) this.pendingPermissions.delete(key);
        for (const key of this.pendingForms.keys()) if (key.startsWith(`${sessionID}:`)) this.pendingForms.delete(key);
        this.emit({ ...base, type: 'turn-ended', status, error });
        if (sessionID !== this.id) this.emit({ ...base, type: 'child-ended', status, error });
        return;
      }
      case 'session.text.delta': this.emit({ ...base, type: 'message-delta', itemId, delta: String(data.delta) }); return;
      case 'session.text.ended': this.emit({ ...base, type: 'message-final', itemId, text: String(data.text) }); return;
      case 'session.reasoning.delta': this.emit({ ...base, type: 'reasoning-delta', itemId, delta: String(data.delta) }); return;
      case 'session.usage.updated':
      case 'session.step.ended':
        this.emit({ ...base, type: 'tokens', usage: object(data.tokens), contextWindow: this.sessionWindows.has(sessionID) ? this.sessionWindows.get(sessionID)! : this.window, cumulative: event.type === 'session.usage.updated', ...(typeof data.cost === 'number' ? { cost: data.cost } : {}) }); return;
      case 'permission.asked': void this.approve(data as PermissionRequest).catch(error => this.reportError(error)); return;
      case 'permission.replied':
        this.pendingPermissions.delete(`${sessionID}:${data.requestID}`);
        this.asks.get(`${sessionID}:${data.requestID}`)?.abort(); return;
      case 'form.created': void this.answer(data.form as FormInfo).catch(error => this.reportError(error)); return;
      case 'form.replied':
      case 'form.cancelled':
        this.pendingForms.delete(`${sessionID}:${data.id}`);
        this.forms.get(`${sessionID}:${data.id}`)?.abort(); return;
    }
    if (['session.tool.input.started', 'session.tool.input.delta', 'session.tool.input.ended', 'session.tool.called', 'session.tool.progress', 'session.tool.success', 'session.tool.failed'].includes(event.type)) {
      const key = `${sessionID}:${data.id}`;
      const old = this.tools.get(key);
      const tool: Tool = { ...(old ?? { id: String(data.id), name: String(data.name ?? 'unknown'), input: '', status: 'streaming', startedAt: event.created ?? Date.now(), durationMs: 0 }) };
      tool.durationMs = Math.max(0, (event.created ?? Date.now()) - tool.startedAt);
      if (event.type === 'session.tool.input.delta') tool.input = String(tool.input) + String(data.delta);
      if (event.type === 'session.tool.input.ended') tool.input = String(data.text);
      if (event.type === 'session.tool.called') { tool.input = object(data.input); tool.status = 'running'; }
      if (data.metadata) tool.metadata = { ...tool.metadata, ...object(data.metadata) };
      if (typeof tool.metadata?.output === 'string') tool.output = tool.metadata.output;
      const ended = event.type === 'session.tool.success' || event.type === 'session.tool.failed';
      if (ended) {
        tool.status = event.type === 'session.tool.success' ? 'completed' : 'failed';
        tool.output = data.content;
        if (data.error) tool.error = String(object(data.error).message ?? 'Tool failed');
      }
      const input = object(tool.input);
      const metadata = tool.metadata ?? {};
      const path = input.filePath ?? input.path ?? metadata.filePath ?? metadata.path;
      if (typeof path === 'string' && /edit|write|patch/.test(tool.name)) {
        tool.edits = [{ path, ...(typeof input.oldString === 'string' ? { before: input.oldString } : {}), ...(typeof input.newString === 'string' ? { after: input.newString } : typeof input.content === 'string' ? { after: input.content } : {}), ...(typeof metadata.diff === 'string' ? { patch: metadata.diff } : {}) }];
      }
      if (Array.isArray(metadata.files)) {
        tool.edits = metadata.files.map(value => {
          const file = object(value);
          return { path: String(file.file), ...(typeof file.patch === 'string' ? { patch: file.patch } : {}) };
        });
      }
      this.emit({ ...base, type: ended ? 'tool-end' : old ? 'tool-update' : 'tool-start', tool });
      if (ended) {
        this.tools.delete(key);
        if (tool.status === 'completed' && tool.name.toLowerCase() === 'todowrite') {
          const todos = metadata.todos ?? input.todos;
          if (Array.isArray(todos)) this.emit({ ...base, type: 'plan', todos: todos as { content: string; status: string }[] });
        }
      } else this.tools.set(key, tool);
      return;
    }
    this.emit({ ...base, type: 'raw', event });
  }

  private emit(event: OpencodeThreadEvent) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (error) { console.error('[opencode] thread listener failed', error); }
    }
  }
}

export const startThread = (options: ThreadOptions) => OpencodeThread.start(options);
export const resumeThread = (sessionID: string, options?: Partial<ThreadOptions>) => OpencodeThread.resume(sessionID, options);
