// Hand-picked from `codex app-server generate-ts --experimental` (codex-cli 0.155.1, ts-exp/ and ts-exp/v2/); only what tarcsweb uses.

export type RequestId = string | number;
export type RpcError = { code: number; message: string; data?: unknown };

// initialize
export type InitializeParams = {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation?: boolean; optOutNotificationMethods?: string[] | null } | null;
};
export type InitializeResponse = { userAgent: string; codexHome: string; platformFamily: string; platformOs: string };

// account
export type PlanType = string;
export type Account = { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: PlanType } | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };
export type GetAccountResponse = { account: Account | null; requiresOpenaiAuth: boolean };
export type LoginAccountParams = { type: 'chatgpt' } | { type: 'chatgptDeviceCode' };
export type LoginAccountResponse =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string }
  | { type: 'chatgptAuthTokens' }
  | { type: 'amazonBedrock' };
export type CancelLoginAccountResponse = { status: string };
export type AccountLoginCompletedNotification = { loginId: string | null; success: boolean; error: string | null };
export type AccountUpdatedNotification = { authMode: string | null; planType: PlanType | null };

// rate limits
export type RateLimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type RateLimitSnapshot = {
  limitId: string | null; limitName: string | null; primary: RateLimitWindow | null; secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null; planType: PlanType | null; rateLimitReachedType: string | null;
};
export type GetAccountRateLimitsResponse = { rateLimits: RateLimitSnapshot; rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null };
export type AccountRateLimitsUpdatedNotification = { rateLimits: RateLimitSnapshot };

// models
export type ReasoningEffort = string;
export type Model = {
  id: string; model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: ReasoningEffort; description: string }[]; defaultReasoningEffort: ReasoningEffort;
  inputModalities: string[]; multiAgentVersion: 'disabled' | 'v1' | 'v2' | null;
};
export type ModelListParams = { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null };
export type ModelListResponse = { data: Model[]; nextCursor: string | null };

// threads and turns
export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type ApprovalsReviewer = 'user' | 'auto_review';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
export type ThreadStartParams = {
  model?: string | null; cwd?: string | null; approvalPolicy?: AskForApproval | null; approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null; config?: Record<string, unknown> | null; developerInstructions?: string | null; ephemeral?: boolean | null;
};
export type ThreadStatus = { type: 'notLoaded' } | { type: 'idle' } | { type: 'systemError' } | { type: 'active'; activeFlags: string[] };
export type Thread = { id: string; cwd: string; model: string | null; reasoningEffort: ReasoningEffort | null; status: ThreadStatus; path: string | null };
export type ThreadStartResponse = { thread: Thread; model: string; cwd: string; reasoningEffort: ReasoningEffort | null };
export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string };
export type TurnStartParams = {
  threadId: string; input: UserInput[]; cwd?: string | null; approvalPolicy?: AskForApproval | null; approvalsReviewer?: ApprovalsReviewer | null;
  sandboxPolicy?: SandboxPolicy | null; model?: string | null; effort?: ReasoningEffort | null; summary?: 'auto' | 'concise' | 'detailed' | 'none' | null;
};
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type TurnError = { message: string; codexErrorInfo: unknown; additionalDetails: string | null };
export type Turn = { id: string; status: TurnStatus; error: TurnError | null; startedAt: number | null; completedAt: number | null; durationMs: number | null };
export type TurnStartResponse = { turn: Turn };

// items (the ones later stages map; the rest pass through as `other`)
export type FileUpdateChange = { path: string; kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }; diff: string };
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type ThreadItem =
  | { type: 'userMessage'; id: string }
  | { type: 'agentMessage'; id: string; text: string; phase?: 'commentary' | 'final_answer' | null }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'commandExecution'; id: string; command: string; cwd: string; status: ItemStatus; aggregatedOutput: string | null; exitCode: number | null; durationMs: number | null }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: ItemStatus }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string; arguments: unknown; durationMs: number | null }
  | {
      type: 'imageGeneration'; id: string; status: string; revisedPrompt: string | null; result: string; transparentBackground?: boolean; savedPath?: string;
      failure: { type: 'usageLimitExceeded'; limitId: string; resetsAt: number | null } | null;
    }
  | { type: 'contextCompaction'; id: string }
  | { type: 'other'; id: string; kind: string };

export type TurnPlanStep = { step: string; status: 'pending' | 'inProgress' | 'completed' };
export type ThreadTokenUsage = {
  total: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
  last: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
  modelContextWindow: number | null;
};

// server -> client requests
export type CommandApprovalParams = {
  threadId: string; turnId: string; itemId: string; approvalId?: string | null; reason?: string | null; command?: string | null; cwd?: string | null;
};
export type FileChangeApprovalParams = { threadId: string; turnId: string; itemId: string; reason?: string | null; grantRoot?: string | null };
export type PermissionsApprovalParams = { threadId: string; turnId: string; itemId: string; cwd: string; reason: string | null; permissions: { network: unknown; fileSystem: unknown } };
// Pre-v2 approval requests, keyed by conversationId instead of threadId.
export type LegacyExecApprovalParams = { conversationId: string; callId: string; command: string[]; cwd: string; reason: string | null };
export type LegacyPatchApprovalParams = { conversationId: string; callId: string; reason: string | null; grantRoot: string | null };
export type ReviewDecision = 'approved' | 'approved_for_session' | { denied: { rejection: string } } | 'abort';

// Request method -> [params, result].
export type Requests = {
  initialize: [InitializeParams, InitializeResponse];
  'account/read': [{ refreshToken?: boolean }, GetAccountResponse];
  'account/login/start': [LoginAccountParams, LoginAccountResponse];
  'account/login/cancel': [{ loginId: string }, CancelLoginAccountResponse];
  'account/logout': [undefined, Record<string, never>];
  'account/rateLimits/read': [undefined, GetAccountRateLimitsResponse];
  'model/list': [ModelListParams, ModelListResponse];
  'thread/start': [ThreadStartParams, ThreadStartResponse];
  'thread/unsubscribe': [{ threadId: string }, { status: string }];
  'turn/start': [TurnStartParams, TurnStartResponse];
  'turn/interrupt': [{ threadId: string; turnId: string }, Record<string, never>];
  'turn/steer': [{ threadId: string; input: UserInput[]; expectedTurnId: string }, { turnId: string }];
};
export type Method = keyof Requests;
