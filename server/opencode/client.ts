import { opencodeServer } from './server.ts';

export type Location = { directory: string };
export type Data<T> = { data: T };
export type Located<T> = Data<T> & { location: Location };
export type Page<T> = Data<T[]> & { cursor: { previous?: string; next?: string } };
export type Query = Record<string, string | number | boolean | undefined>;
export type ModelRef = { id: string; providerID: string; variant?: string };
export type Ruleset = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }[];
export type SessionCreate = { id?: string; parentID?: string; title?: string; agent?: string; model?: ModelRef; location?: Location; metadata?: Record<string, unknown>; permissions?: Ruleset };
export type SessionInfo = SessionCreate & { id: string; projectID: string; location: Location; cost: number; tokens: Record<string, unknown>; time: { created: number; updated: number }; outcome?: 'succeeded' | 'failed' | 'interrupted' };
export type SessionUpdate = Pick<SessionCreate, 'title' | 'metadata' | 'permissions'> & { archived?: boolean };
export type PromptRequest = { text: string; id?: string; metadata?: Record<string, unknown>; delivery?: 'steer' | 'queue'; resume?: boolean; files?: { uri: string; name?: string; description?: string }[]; agents?: { name: string }[]; skills?: { id: string }[] };
export type Message = { id: string; type: string; time: { created: number; completed?: number }; text?: string; content?: Array<{ type: string; text?: string; [key: string]: unknown }>; [key: string]: unknown };
export type InboxItem<Type extends 'user' | 'synthetic' | 'compaction' | 'move' = 'user' | 'synthetic' | 'compaction' | 'move'> = { id: string; sessionID: string; type: Type; delivery: 'steer' | 'queue'; payload: Record<string, unknown>; time: { created: number } };
export type PermissionRequest = { id: string; sessionID: string; action: string; resources: string[]; save?: string[]; metadata?: Record<string, unknown>; source?: { type: 'tool'; messageID: string; id: string }; message?: string };
export type FormAnswer = Record<string, string | number | boolean | string[]>;
export type FormInfo = { id: string; sessionID: string; title: string; fields: Array<{ key: string; type: string; title?: string; description?: string; options?: { value: string; label: string }[]; [key: string]: unknown }> };
export type FormDetail = FormInfo & { state: { status: 'pending' | 'answered' | 'cancelled'; answer?: FormAnswer; message?: string } };
export type ModelInfo = { id: string; modelID: string; providerID: string; name: string; enabled: boolean; variants: { id: string }[]; limit: { context: number; input?: number; output: number }; capabilities: { tools: boolean; input: string[]; output: string[] }; cost: { input: number; output: number }[] };
export type ProviderInfo = { id: string; name: string; integrationID?: string; activation: string };
export type Connection = { type: 'credential' | 'env'; id?: string; name?: string; label?: string; method?: string; status?: { status: 'needs_auth'; message: string; url?: string } };
export type IntegrationInfo = { id: string; name: string; methods: { type: string; id?: string; label?: string; names?: string[] }[]; connections: Connection[] };
export type AgentInfo = { id: string; name: string; description?: string; model?: ModelRef; mode: 'subagent' | 'primary' | 'all'; hidden: boolean; permissions: Ruleset };
export type SkillInfo = { id: string; name: string; description?: string; [key: string]: unknown };
export type McpConfig = { type: 'remote'; url: string; headers?: Record<string, string>; oauth?: false; disabled?: boolean; codemode?: boolean; timeout?: { startup?: number; catalog?: number; execution?: number } };
export type McpServer = { name: string; status: { status: 'connected' | 'pending' | 'disabled' | 'failed' | 'needs_auth'; error?: string }; title?: string; integrationID?: string };
export type FileDiff = { file: string; patch: string; additions: number; deletions: number; status: 'added' | 'deleted' | 'modified'; more?: true };
export type OpencodeEvent = { type: string; data: Record<string, unknown>; id?: string; created?: number; location?: Location; durable?: { aggregateID: string; seq: number; version: number } };
export type Info = { version: string; [key: string]: unknown };

export class OpencodeError extends Error {
  readonly status: number;
  readonly _tag: string | null;
  constructor(status: number, tag: string | null, message: string) {
    super(message);
    this.name = 'OpencodeError';
    this.status = status;
    this._tag = tag;
  }
}

const enc = encodeURIComponent;
const session = (id: string) => `/api/session/${enc(id)}`;

class OpencodeClient {
  private async response(path: string, method: string, body?: unknown, location?: Location, query: Query = {}, signal?: AbortSignal) {
    const endpoint = await opencodeServer.start();
    const url = new URL(path, endpoint.url);
    if (location) url.searchParams.set('location[directory]', location.directory);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method, headers: { Authorization: endpoint.authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text();
      let error: { _tag?: string; message?: string } = {};
      try { error = JSON.parse(text); } catch { /* Non-JSON proxy errors still carry their HTTP status. */ }
      throw new OpencodeError(response.status, error?._tag ?? null, error?.message ?? `OpenCode HTTP ${response.status}: ${text.slice(0, 1000)}`);
    }
    return response;
  }

  private async request<T>(path: string, method = 'GET', body?: unknown, location?: Location, query?: Query): Promise<T> {
    const response = await this.response(path, method, body, location, query);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  info = () => this.request<Info>('/api/info');
  createSession = (body: SessionCreate = {}) => this.request<Data<SessionInfo>>('/api/session', 'POST', body);
  getSession = (id: string) => this.request<Data<SessionInfo>>(session(id));
  activeSessions = () => this.request<Data<Record<string, unknown>>>('/api/session/active');
  listSessions = (query?: Query) => this.request<Page<SessionInfo>>('/api/session', 'GET', undefined, undefined, query);
  updateSession = (id: string, body: SessionUpdate) => this.request<void>(session(id), 'PATCH', body);
  deleteSession = (id: string) => this.request<void>(session(id), 'DELETE');
  prompt = (id: string, body: PromptRequest) => this.request<Data<InboxItem<'user'>>>(`${session(id)}/prompt`, 'POST', body);
  interrupt = (id: string, resume?: boolean) => this.request<{ interrupted: boolean }>(`${session(id)}/interrupt`, 'POST', undefined, undefined, { resume });
  fork = (id: string, before?: string) => this.request<Data<SessionInfo>>(`${session(id)}/fork`, 'POST', { before });
  compact = (id: string, body: { id?: string; delivery?: 'steer' | 'queue' } = {}) => this.request<Data<InboxItem<'compaction'>>>(`${session(id)}/compact`, 'POST', body);
  setModel = (id: string, model: ModelRef) => this.request<void>(`${session(id)}/model`, 'POST', { model });
  setAgent = (id: string, agent: string) => this.request<void>(`${session(id)}/agent`, 'POST', { agent });
  listMessages = (id: string, query?: Query) => this.request<Page<Message>>(`${session(id)}/message`, 'GET', undefined, undefined, query);
  getMessage = (id: string, messageID: string) => this.request<Data<Message>>(`${session(id)}/message/${enc(messageID)}`);
  diff = (id: string, query?: { from?: string; to?: string; context?: number }) => this.request<Data<FileDiff[]>>(`${session(id)}/diff`, 'GET', undefined, undefined, query);
  inbox = (id: string) => this.request<Data<InboxItem[]>>(`${session(id)}/inbox`);
  cancelInbox = (id: string, inboxID: string) => this.request<void>(`${session(id)}/inbox/${enc(inboxID)}`, 'DELETE');
  updateInbox = (id: string, inboxID: string, delivery: 'steer' | 'queue') => this.request<void>(`${session(id)}/inbox/${enc(inboxID)}`, 'PATCH', { delivery });
  listPermissions = (id: string) => this.request<Data<PermissionRequest[]>>(`${session(id)}/permission`);
  permissions = (location?: Location) => this.request<Located<PermissionRequest[]>>('/api/permission/request', 'GET', undefined, location);
  replyPermission = (id: string, requestID: string, decision: 'once' | 'always' | 'reject', message?: string) => this.request<void>(`${session(id)}/permission/${enc(requestID)}/reply`, 'POST', { decision, message });
  listForms = (id: string) => this.request<Data<FormInfo[]>>(`${session(id)}/form`);
  forms = (location?: Location) => this.request<Located<FormInfo[]>>('/api/form', 'GET', undefined, location);
  getForm = (id: string, formID: string) => this.request<Data<FormDetail>>(`${session(id)}/form/${enc(formID)}`);
  replyForm = (id: string, formID: string, answer: FormAnswer) => this.request<void>(`${session(id)}/form/${enc(formID)}/reply`, 'POST', { answer });
  cancelForm = (id: string, formID: string, message?: string) => this.request<void>(`${session(id)}/form/${enc(formID)}`, 'DELETE', undefined, undefined, { message });
  putInstruction = (id: string, key: string, value: unknown) => this.request<void>(`/api/experimental/session/${enc(id)}/instructions/entries/${enc(key)}`, 'PUT', { value });
  deleteInstruction = (id: string, key: string) => this.request<void>(`/api/experimental/session/${enc(id)}/instructions/entries/${enc(key)}`, 'DELETE');
  skills = (location?: Location) => this.request<Located<SkillInfo[]>>('/api/skill', 'GET', undefined, location);
  agents = (location?: Location) => this.request<Located<AgentInfo[]>>('/api/agent', 'GET', undefined, location);
  models = (location?: Location) => this.request<Located<ModelInfo[]>>('/api/model', 'GET', undefined, location);
  defaultModel = (location?: Location) => this.request<Located<ModelInfo | null>>('/api/model/default', 'GET', undefined, location);
  providers = (location?: Location) => this.request<Located<ProviderInfo[]>>('/api/provider', 'GET', undefined, location);
  integrations = (location?: Location) => this.request<Located<IntegrationInfo[]>>('/api/integration', 'GET', undefined, location);
  mcp = (location?: Location) => this.request<Located<McpServer[]>>('/api/mcp', 'GET', undefined, location);
  putMcp = (name: string, config: McpConfig, location: Location) => this.request<void>(`/api/experimental/mcp/${enc(name)}`, 'PUT', { config }, location);
  deleteMcp = (name: string, location: Location) => this.request<void>(`/api/experimental/mcp/${enc(name)}`, 'DELETE', undefined, location);

  async *subscribe(options: { sessionID?: string; signal?: AbortSignal; onFrame?: (frame: string) => void } = {}): AsyncGenerator<OpencodeEvent> {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const arm = () => setTimeout(() => controller.abort(new Error('OpenCode event stream received no bytes for 45 seconds')), 45_000);
    let timer = arm();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.response('/api/event', 'GET', undefined, undefined, {}, signal);
      if (!response.body) throw new Error('OpenCode event stream has no body');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error('OpenCode event stream closed');
        clearTimeout(timer);
        timer = arm();
        pending += decoder.decode(value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, match.index);
          pending = pending.slice(match.index + match[0].length);
          options.onFrame?.(frame);
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const event = JSON.parse(data) as OpencodeEvent;
          if (!options.sessionID || event.data?.sessionID === options.sessionID) yield event;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
}

export const opencode = new OpencodeClient();
