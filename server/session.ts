import { randomUUID, type UUID } from 'node:crypto';
import { watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir, open, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { query, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, HookCallback, McpServerConfig, ModelUsage, Options, PermissionResult, Query, SDKMessage, SDKRateLimitInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment, ContextUsage, DockState, Effort, ExplainEvent, HandoffPhase, HandoffState, HeadsUp, LimitKey, Limits, LogSource, Mode, Panel, ReplayInfo, SeqEvent,
  ServerEvent, SessionMap, SessionSummary, Settings, Status, Toast, Upload, AskReply, Question, McpPack, SlashItem, McpGroup, McpRow,
  McpAuthReply, McpPhase, ServerMessage, TimedEvent, WatchPage, RoundPick, ReplyStyle, StretchSeen, RemoteState, FindHit,
} from './protocol.ts';
import { ColdLog, FIND_MAX, LOG_MAX, hitOf, mergeHits, trimPoint } from './coldLog.ts';
import { PHONE_NOTE, bridgeState, phoneMessage, remoteUrl, type PhoneMessage, type RemoteControl } from './remote.ts';
import { fullText } from './stretch.ts';
import { WatchTimeline, transcriptPath } from './watch.ts';
import { earlierMessages, historyOf } from './history.ts';
import {
  MODS, catalog, defaultOn, groupOf, mcpPacks, packOf, rememberSeen, saveChoices, saveMcp, savedChoices, savedMcp, seenServers, serversFor, type Catalog,
} from './mcp.ts';
import { HANDOFF_PREFIX, agentNote, type UiNode, type UiPromptAnswer, type UiPromptOp } from './protocol.ts';
import { PluginSurface, type UiAsk } from './surface.ts';
import { AgentTracker } from './agents.ts';
import { ChangeLog } from './changes.ts';
import {
  APP_TOOLS, EDIT_TOOLS, PLUMBING, STREAMED, ToolLog, describeTool, diffDetail, parsePartial, roundKey, summarizeFor, toolName, toolName as displayTool,
} from './tools.ts';
import { APP_TOOL_NAMES, appServer, type Brokers, type ChoiceBroker, type RoundBroker } from './appTools.ts';
import { STRETCH_GUIDE, VISUAL_PROMPT, VISUAL_REMINDER, stretchNote } from './prompt.ts';
import { dataUrlImage, imageUrl, loadReplay, readReplayText, revokeAll } from './files.ts';
import { oneLine } from './text.ts';
import { Chapters, type TitleJob } from './chapters.ts';
import type { Titles } from './titles.ts';
import type { Voice } from './voice.ts';
import type { Phone } from './phone.ts';
import { explainError, resultText, tldr } from './notes.ts';
import { CommandCache, learnTerminal, localOutput, menuOf } from './commands.ts';
import { answerLight, explain, type ExplainRequest, type Fork } from './explain.ts';
import { config, handoffAt, t } from './config.ts';

// Handoff runs well before the SDK's auto-compact, so it only counts below the model's window.
const handoffBelow = (max: number) => {
  const at = handoffAt();
  return at !== null && at < max ? at : null;
};

// context-handoff never compacts under the SDK, so the app runs the handoff itself (see runHandoff).
// The mods ship in the repo; the CLI wants absolute paths.
const WEB_MODS = ['visual', 'replay', 'agents-panel'].map((m) => fileURLToPath(new URL(`../mods/${m}`, import.meta.url))).join(':');

const PROGRESS_TOOL = 'mcp__agents-panel__progress';
const PROGRESS_NOTE = `\n\nProgress reporting: call ${PROGRESS_TOOL} (load it with ToolSearch "select:${PROGRESS_TOOL}" if needed) once at the start with {task, total, done: 0, step}, then after each step with done + 1 and a short name for the next step.`;

// Verbatim from the context-handoff mod.
const HANDOFF_PROMPT = `Write a handoff document summarising this conversation so a fresh agent can continue the work exactly where it stands.

Include:
- Objective and current status (done, in progress, blocked)
- Decisions taken and why, including the user's preferences and constraints
- Files touched or relevant, by path
- The exact next steps, most urgent first
- Open questions waiting on the user
- A "suggested skills" section naming which skills the next agent should load

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs); reference them by path or URL.
Redact any sensitive information such as API keys, passwords or personal data.
Answer with the document only, in Markdown, in English.`;
const COMPACT_INSTRUCTIONS =
  'A detailed handoff document was written just before this compaction and will be handed to you. Keep this summary short: the task in progress, the files open and any request from the user still pending.';
const HANDOFF_DIR = '/tmp/claude-handoffs';
const HANDOFF_TAIL = 'This message was sent automatically. Reply only with "Handoff loaded." and wait for the next message.';
// A compaction must free at least this much before another handoff can start.
const HANDOFF_GAIN = 10_000;
const HANDOFF_TRIES = 2;
const TOAST_MS = 5000;
// Phone push titles for a wait on the user.
const WAIT = t({
  en: { question: 'Claude has a question', plan: 'Claude has a plan', other: 'Claude needs you' },
  'pt-BR': { question: 'Claude tem uma pergunta', plan: 'Claude tem um plano', other: 'Claude precisa de você' },
});
// The CLI gives a composer question 5 s; answer before it gives up.
const UI_ASK_MS = 4000;
type HandoffDoc = { path: string; text: string };
type Held = { text: string; pastes: string[]; files: Upload[]; thumbs: (string | null)[]; cid?: string };

type ContentBlockParam = Exclude<SDKUserMessage['message']['content'], string>[number];

function fileBlock(f: Upload): ContentBlockParam {
  if (f.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: f.mime as 'image/png', data: f.data } };
  if (f.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name };
  return { type: 'text', text: `File ${f.name}:\n\n${f.data}` };
}

const FLUSH_MS = 50;
const IDLE_MS = 5 * 60_000;
// Claude in Chrome, offered in the MCP menu but started with the CLI's --chrome flag (no extra process).
const CHROME = 'claude-in-chrome';
const LIVE_MAX = 200;
// A CLI warmed by typing that never got a message goes away after this.
const WARM_MS = 2 * 60_000;
// How long a sign-in started from the MCP menu keeps the CLI alive and its state polled.
const AUTH_WAIT_MS = 5 * 60_000;

// Re-read on edit, so a reloaded session gets the new prompt without restarting the server.
let visualPrompt = VISUAL_PROMPT;
let visualReminder = VISUAL_REMINDER;
let stretchGuide = STRETCH_GUIDE;
let noteOf = stretchNote;
const promptUrl = new URL('./prompt.ts', import.meta.url);
watchFile(fileURLToPath(promptUrl), { interval: 1500 }, () => {
  import(`${promptUrl.href}?t=${Date.now()}`).then((m: typeof import('./prompt.ts')) => {
    visualPrompt = m.VISUAL_PROMPT;
    visualReminder = m.VISUAL_REMINDER;
    stretchGuide = m.STRETCH_GUIDE;
    noteOf = m.stretchNote;
  }, () => {});
}).unref();
const PANEL_MS = 150;
const LOG_TAIL = 64 * 1024;
const MAP_MS = 150;
const LAZY_TITLES = 10;
const CTX_WARN = 60;
// A window's reset time to the minute, so a second of jitter in the CLI's report keeps the same id.
const minute = (ms: number | null) => (ms ? Math.round(ms / 60_000) : 0);
const LIMIT_WARN = 80;
// Streaming tool input is re-parsed at most this often.
const PARTIAL_MS = 80;
const LIMIT_LABEL: Record<LimitKey, string> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' };

// What a session needs from the rest of the server.
export type Hub = {
  titles: Titles; voice: Voice; phone: Phone; limits: () => Limits | null; peers: (id: string) => SessionSummary[]; rateLimit: (info: SDKRateLimitInfo) => void;
  commands: CommandCache;
  // Account-wide heads-ups (usage limits): dismissed once for every session, and kept across restarts.
  accountDismissed: (id: string) => boolean;
  dismissAccount: (id: string) => void;
  // A CLI started or went idle; the manager stops the least recently used idle ones past its cap.
  cliIdle: () => void;
};

// Rows whose JSON changed since the last send, and the id list when it changed; sent is rebuilt in the current order.
function diffRows(rows: { id: string }[], sent: Map<string, string>) {
  const prev = new Map(sent);
  const before = [...prev.keys()];
  const changed: string[] = [];
  let moved = rows.length !== before.length;
  sent.clear();
  for (const [i, r] of rows.entries()) {
    const j = JSON.stringify(r);
    if (prev.get(r.id) !== j) changed.push(j);
    if (before[i] !== r.id) moved = true;
    sent.set(r.id, j);
  }
  return { changed, order: moved ? JSON.stringify(rows.map((r) => r.id)) : null };
}

const tok = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const clock = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// Public in the CLI protocol (get_task_output) but missing from the Query type in sdk.d.ts.
type TaskOutput = { output: string; total_bytes: number; truncated: boolean };
type WithTaskOutput = Query & { getTaskOutput?: (taskId: string) => Promise<TaskOutput> };
type WithRemote = Query & RemoteControl;

// Cap for the per-session id and prompt memories that tell Remote Control turns apart.
const ID_CAP = 200;
const OWN_TEXTS = 20;
function capAdd(set: Set<string>, id: string) {
  set.add(id);
  if (set.size > ID_CAP) set.delete(set.values().next().value!);
}

const PI_INBOX = `${process.env.XDG_RUNTIME_DIR || '/tmp'}/pi-inbox/`;
const PI_POLL_MS = 1500;
// Enough recent messages for a cheap explanation to know what the excerpt refers to.
const RECENT_CHARS = 12_000;

async function tailFile(path: string) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, LOG_TAIL);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return { text: buf.toString('utf8'), truncated: size > len };
  } finally {
    await fh.close();
  }
}

// The file a command sends its output to (`> f`, `&> f`, `| tee f` at its end), resolved against its leading cd.
function redirectTarget(command: string, cwd: string): string | null {
  const cmd = command.trim();
  const m = /(?:&>>?|\d?>>?|\|\s*tee(?:\s+-a)?)\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)(?:\s+2>&1)?\s*&?$/.exec(cmd);
  if (!m) return null;
  const path = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2').replace(/^~(?=\/|$)/, homedir());
  const target = path(m[1]!);
  if (target.includes('$') || target.startsWith('/dev/')) return null;
  const cd = /^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&/.exec(cmd);
  return resolve(cd ? resolve(cwd, path(cd[1]!)) : cwd, target);
}

// Async iterable the SDK pulls user messages from (streaming-input mode).
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(item: SDKUserMessage) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

export { oneLine };

// Dock and title names: the first few words, cut at a word boundary.
export function shortTitle(s: string, max = 40) {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : max).replace(/[\s,.;:!?-]+$/, '') + '…';
}

export type SessionInit = Settings & {
  id: string;
  cwd: string;
  name: string;
  branch: string | null;
  // Transcript id to resume; null until the session has a transcript on disk.
  resumeId: string | null;
  chapters?: Chapters;
  tools?: ToolLog;
  // The first message resumed, when it is a compaction summary: the conversation before it loads from the transcript on request.
  firstUuid?: string;
};

type Ask = { tool: string; summary: string };

// An AskUserQuestion input in the card's shape; a malformed one falls back to the plain permission card.
function questionsOf(input: Record<string, unknown>): Question[] | undefined {
  if (!Array.isArray(input.questions)) return undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const out = input.questions.flatMap((q: Record<string, unknown>) =>
    q && typeof q.question === 'string' && Array.isArray(q.options)
      ? [{
          question: q.question, header: str(q.header), multiSelect: q.multiSelect === true,
          options: q.options.map((o: Record<string, unknown>) => ({ label: str(o?.label), description: str(o?.description), ...(typeof o?.preview === 'string' ? { preview: o.preview } : {}) })),
        }]
      : [],
  );
  return out.length ? out : undefined;
}
export type UiPromptAsk = { type: 'ui-prompt'; sessionId: string; id: string; op: UiPromptOp; text?: string; mode?: string };
// An option index or own words (ask_choice), or one pick per question (ask_round).
type AskPick = number | string | RoundPick[];
// An ask_choice or ask_round handler waiting for the user; id stays null until its tool_use is seen.
// question is what matches it to that tool_use; fits rejects a pick out of range.
type ChoiceWait = { id: string | null; tool: string; question: string; summary: string; fits: (pick: AskPick) => boolean; resolve: (pick: AskPick | null) => void };
type Streaming = { id: string; name: string; json: string; timer: ReturnType<typeof setTimeout> | null };
// Forks that must never wait on the user.
const NO_ASK: Brokers = { choose: async () => null, round: async () => null };

// "Waiting for you to run pnpm test": the live line for a pending permission.
function waitingText(a: Ask) {
  if (a.tool === APP_TOOLS.choice) return 'Waiting for your answer';
  if (a.tool === APP_TOOLS.round) return 'Waiting for your answers';
  if (a.tool === 'Bash') return `Waiting for you to run ${oneLine(a.summary, 60)}`;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(a.tool)) return `Waiting for you to allow editing ${a.summary.split('/').pop()}`;
  return `Waiting for you to allow ${toolName(a.tool)}`;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  name: string;
  branch: string | null;
  mode: Mode;
  model: string;
  effort: Effort;
  status: Status = 'idle';
  lastActive = Date.now();
  doneAt = 0;
  private resumeId: string | null;
  private named: boolean;
  // False until the transcript exists on disk (a new session's first turn ended).
  private persisted: boolean;
  private pendingTitle: string | null = null;
  private done: Promise<void> | null = null;
  private unseenDone = false;
  // Newest events only: past LOG_MAX the oldest move to `cold` on disk, cut at a prompt, leaving about LOG_KEEP.
  private log: SeqEvent[] = [];
  private cold: ColdLog | null = null;
  // The newest prompt that went to disk, so recentText still has it when a long turn outgrows the log.
  private spilledPrompt: SeqEvent | null = null;
  // The resumed transcript's segments before its last compaction: seqs up to 0, read on the first page or search that needs them.
  private preFrom: { tid: string; uuid: string } | null = null;
  private pre: Promise<ColdLog | null> | null = null;
  // For a merged text entry: the seq of each chunk it holds and where that chunk starts in delta.
  private textCuts = new WeakMap<SeqEvent, { seq: number; at: number }[]>();
  private seq = 0;
  private listeners = new Set<(e: SeqEvent) => void>();
  private q: Query | null = null;
  private queue: PromptQueue | null = null;
  private pending = new Map<string, (allow: boolean, reply?: AskReply) => void>();
  // Messages sent mid-turn that the CLI has not picked up yet.
  private queuedIds = new Set<string>();
  // What a queued message held, so it can be sent again as an interrupting one.
  private queuedMsgs = new Map<string, { text: string; pastes: string[]; files: Upload[]; thumbs: (string | null)[] }>();
  private textBuf = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Last warm-up, message or activity of the CLI: the LRU key for the manager's idle cap.
  usedAt = 0;
  // Last time the conversation moved (a send, a reply, a permission); 0 if only viewed.
  wroteAt = 0;
  // False while the current CLI is only warm, before any message reached it.
  private used = false;
  private streamedIds = new Set<string>();
  private currentMsgId: string | null = null;
  private tracker: AgentTracker;
  private changes: ChangeLog;
  private panelListeners = new Set<(json: string) => void>();
  private panelTimer: ReturnType<typeof setTimeout> | null = null;
  // What the panel's clients hold, as row JSON by id in order, so a tick sends only what changed.
  private sentAgents = new Map<string, string>();
  private sentProcs = new Map<string, string>();
  private sentActive = false;
  private piTimer: ReturnType<typeof setInterval> | null = null;
  private background = false;
  private hub: Hub;
  private chapters: Chapters;
  // Only sessions started here get an automatic name, and only until the user renames them.
  private createdHere: boolean;
  private userRenamed = false;
  private asks = new Map<string, Ask>();
  private activity = '';
  private compacting = false;
  private compactions = 0;
  private lastCompact: { pre: number; post: number | null; trigger: string } | null = null;
  private compactError: string | null = null;
  private ctx: ContextUsage | null = null;
  private cost: number | null = null;
  private tokens: number | null = null;
  private dismissed = new Set<string>();
  private mapListeners = new Set<(json: string) => void>();
  private mapTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMap = '';
  private tools: ToolLog;
  private streaming = new Map<number, Streaming>();
  private lastPartial = new Map<string, string>();
  // Built on the first watch-load; its entries are capped inside WatchTimeline.
  private watch: WatchTimeline | null = null;
  private choices: ChoiceWait[] = [];
  // ask_choice and ask_round tool_use ids seen before their handler ran, and clicks that came before it.
  private unclaimed: { id: string; tool: string; question: string }[] = [];
  private early = new Map<string, AskPick>();
  private handoff: HandoffState | null = null;
  // A written doc kept for the retry when a later phase failed.
  private handoffDoc: HandoffDoc | null = null;
  private handoffTries = 0;
  private handoffPost: number | null = null;
  private handoffAbort: AbortController | null = null;
  // Resolved by handle(): the /compact command's result, then the hand-over turn's result.
  private handoffWait: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private compactedNow = false;
  private held: Held[] = [];
  // A prompt sent while a turn ran may still be queued in the CLI; the handoff waits for the next turn end.
  private sentBusy = false;
  private toasts: Toast[] = [];
  // Optional MCP sets this session loads, and what their servers last reported.
  private mcp: string[];
  private mcpState: Record<string, Pick<McpPack, 'state' | 'error'>> = {};
  // Settings-loaded servers (user, folder, claude.ai, plugins) this session switched away from defaultOn.
  private mcpChoices: Record<string, boolean>;
  // The running CLI's own server list; null while no CLI runs. Capped at LIVE_MAX.
  private mcpLive: { name: string; status: string; source?: string; error?: string; tools?: number }[] | null = null;
  private mcpCatalog: Catalog | null = null;
  private mcpRows: McpRow[] = [];
  private mcpJson = '';
  private mcpListeners = new Set<(json: string) => void>();
  // Set when a flag change (Chrome) waits for the turn to end before the CLI restarts.
  private cliStale = false;
  // What the running CLI was started with, so the menu can mark choices it does not have yet.
  private cliOff = new Set<string>();
  private cliChrome = false;
  // A restart for MCP changes until the new CLI reports its servers; the last boot failure for the menu.
  private mcpRestarting = false;
  private mcpError: string | null = null;
  // Sign-ins started from the menu, until the server connects or the wait runs out.
  private authUntil = new Map<string, number>();
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  // An early interrupt can still end the turn as 'success'; this keeps it reported as stopped.
  private stopRequested = false;
  private appMcp: McpServerConfig | null = null;
  // The mode an approved plan returns to unless the user picks another.
  private beforePlan: Mode;
  // The newest main-thread text item of the running turn; its tldr lands there.
  private lastTextId: string | null = null;
  // Main-thread Bash commands by tool_use id, and calls the user denied, for the error notes.
  private bashCalls = new Map<string, string>();
  private denied = new Set<string>();
  private forks = new Set<AbortController>();
  // Plugins' band above the prompt, and the composer questions they ask the clients.
  private surface: PluginSurface | null = null;
  private above: UiNode | null = null;
  private uiPromptListeners = new Set<(m: UiPromptAsk) => void>();
  private uiAsks = new Map<string, (a: UiPromptAnswer | null) => void>();
  // This process's slash commands; null until it answers, then the hub's cache stands in.
  private slash: SlashCommand[] | null = null;
  private commandListeners = new Set<(c: SlashItem[]) => void>();
  // A compaction re-sends kept local command output under the same uuid.
  private localSeen = new Set<string>();
  // The reply style the clients last asked for, and the one the running CLI was started with.
  private style: ReplyStyle = 'stretch';
  private cliStyle: ReplyStyle | null = null;
  // Which stretches of the last reply were opened; rides on the next prompt the CLI submits.
  private stretchNote: string | null = null;
  // Remote Control: wanted outlives a CLI restart (it is turned on again); remote is what the clients see, null when off.
  private remoteWanted = false;
  private remote: RemoteState | null = null;
  // Bumped on every enable, disable and CLI stop, so a late answer from an older call is dropped.
  private remoteGen = 0;
  private remoteEnabling = false;
  // Prompt uuids this server sent and turn uuids already checked, so a phone turn stands out. Capped at ID_CAP.
  private ownIds = new Set<string>();
  private seenTurns = new Set<string>();
  // Prompts sent from here whose UserPromptSubmit has not fired yet, oldest first; capped at OWN_TEXTS.
  private ownTexts: string[] = [];
  // Stream messages held while a phone message is read from the transcript, so it lands before its reply.
  private phoneHold: SDKMessage[] | null = null;
  private phoneTurn = false;

  private onChange: () => void;

  constructor(init: SessionInit, onChange: () => void, hub: Hub) {
    this.onChange = onChange;
    this.hub = hub;
    this.chapters = init.chapters ?? new Chapters();
    this.tools = init.tools ?? new ToolLog(init.cwd);
    this.createdHere = init.resumeId === null;
    this.id = init.id;
    this.cwd = init.cwd;
    this.name = init.name;
    this.branch = init.branch;
    this.mode = init.mode;
    this.model = init.model;
    this.effort = init.effort;
    this.resumeId = init.resumeId;
    if (init.resumeId && init.firstUuid) this.preFrom = { tid: init.resumeId, uuid: init.firstUuid };
    this.named = init.resumeId !== null;
    this.persisted = init.resumeId !== null;
    this.mcp = savedMcp(init.id);
    this.mcpChoices = savedChoices(init.id);
    void this.loadCatalog();
    this.beforePlan = init.mode === 'plan' ? 'default' : init.mode;
    this.tracker = new AgentTracker(this.cwd, {
      model: () => this.model, effort: () => this.effort, changed: () => this.panelChanged(),
      edited: (path, add, rm) => this.chapters.edited(path, add, rm), read: (path) => this.chapters.read(path),
    });
    this.changes = new ChangeLog(this.cwd, (card) => this.push({ type: 'changes', ...card }), (owner) => this.tracker.nameOf(owner) ?? 'Agent');
  }

  map(): SessionMap {
    return {
      chapters: this.chapters.snapshot(), now: this.nowText(), need: this.asks.size > 0, headsUps: this.headsUps(),
      usage: { ctx: this.ctx, cost: this.cost, tokens: this.tokens, compacting: this.compacting },
      handoff: this.handoff, toasts: this.toasts.filter((t) => t.until > Date.now()), above: this.above,
    };
  }

  private get handingOff() {
    const p = this.handoff?.phase;
    return p === 'writing' || p === 'compacting' || p === 'handing';
  }

  private toast(text: string, ms = TOAST_MS) {
    const now = Date.now();
    this.toasts = [...this.toasts.filter((t) => t.until > now).slice(-4), { id: randomUUID(), text, until: now + ms }];
    this.mapChanged();
  }

  // Listeners get the serialized map message, built once for every client.
  subscribeMap(fn: (json: string) => void) {
    this.mapListeners.add(fn);
    return () => this.mapListeners.delete(fn);
  }

  // Coalesced and deduplicated: streaming text only matters when the live line changes.
  mapChanged() {
    this.mapTimer ??= setTimeout(() => {
      this.mapTimer = null;
      if (!this.mapListeners.size) return;
      const json = JSON.stringify(this.map());
      if (json === this.lastMap) return;
      this.lastMap = json;
      const msg = `{"type":"map","sessionId":${JSON.stringify(this.id)},${json.slice(1)}`;
      for (const fn of this.mapListeners) fn(msg);
    }, MAP_MS);
  }

  dismiss(id: string) {
    if (id.startsWith('limit')) {
      this.hub.dismissAccount(id);
      return;
    }
    this.dismissed.add(id);
    this.mapChanged();
  }

  uiPress(plugin: string, key: string | null, path: number[], href?: string) {
    void this.surface?.press(plugin, key, path, href);
  }

  commands(): SlashItem[] {
    const list = this.slash ?? this.hub.commands.get(this.cwd);
    return list ? menuOf(list) : [];
  }

  subscribeCommands(fn: (c: SlashItem[]) => void) {
    this.commandListeners.add(fn);
    return () => this.commandListeners.delete(fn);
  }

  private setCommands(list: SlashCommand[]) {
    this.slash = list;
    this.hub.commands.set(this.cwd, list);
    const menu = this.commands();
    for (const fn of this.commandListeners) fn(menu);
  }

  private async loadCommands(q: Query) {
    try {
      const list = await q.supportedCommands();
      if (this.q === q) this.setCommands(list);
    } catch {}
  }

  subscribeUiPrompt(fn: (m: UiPromptAsk) => void) {
    this.uiPromptListeners.add(fn);
    return () => this.uiPromptListeners.delete(fn);
  }

  answerUiPrompt(id: string, answer: UiPromptAnswer) {
    this.uiAsks.get(id)?.(answer);
  }

  // The first client showing this session answers; none in time reads as an empty, unavailable composer.
  private askComposer(a: UiAsk): Promise<UiPromptAnswer | null> {
    if (!this.uiPromptListeners.size) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise((resolve) => {
      const done = (answer: UiPromptAnswer | null) => {
        clearTimeout(timer);
        this.uiAsks.delete(id);
        resolve(answer);
      };
      const timer = setTimeout(() => done(null), UI_ASK_MS);
      this.uiAsks.set(id, done);
      for (const fn of this.uiPromptListeners) fn({ type: 'ui-prompt', sessionId: this.id, id, ...a });
    });
  }

  // The sheet opened: give a few old chapters a real title.
  mapOpened() {
    for (const job of this.chapters.untitled(LAZY_TITLES)) this.requestTitle(job);
  }

  private requestTitle(job: TitleJob) {
    const wantName = job.first && this.createdHere && !this.userRenamed;
    this.hub.titles.request(job, wantName, (r) => {
      this.chapters.titled(job.id, r.title);
      if (wantName && r.name && !this.userRenamed) this.autoName(r.name);
      this.mapChanged();
    });
  }

  private autoName(name: string) {
    this.name = name;
    this.onChange();
    if (!this.persisted) this.pendingTitle = name;
    else renameSession(this.resumeId!, name).catch((err) => this.push({ type: 'error', message: `Rename failed: ${String(err)}` }));
  }

  private nowText() {
    if (this.handoff?.phase === 'writing') return 'Writing the handoff';
    if (this.handoff?.phase === 'handing') return 'Handing over';
    if (this.compacting) return 'Compacting the conversation';
    const ask = this.asks.values().next().value;
    if (ask) return waitingText(ask);
    if (this.status === 'working') return this.activity || 'Thinking';
    const running = this.tracker.snapshot().procs.filter((p) => p.state === 'running').length;
    return running ? `Idle · ${running} process${running > 1 ? 'es' : ''} running` : 'Idle';
  }

  private headsUps(): HeadsUp[] {
    const out: HeadsUp[] = [];
    const add = (h: Omit<HeadsUp, 'dismissable'>, dismissable = true) => out.push({ ...h, dismissable });
    for (const [id, a] of this.asks) {
      if (a.tool === APP_TOOLS.choice || a.tool === APP_TOOLS.round) {
        const text = a.tool === APP_TOOLS.round ? 'Some questions are waiting for you' : 'A question is waiting for you';
        add({ id: `choice:${id}`, need: true, text, detail: a.summary, action: { kind: 'review', target: id } }, false);
        continue;
      }
      const what = a.tool === 'Bash' ? 'A command' : EDIT_TOOLS.test(a.tool) ? 'A file edit' : toolName(a.tool);
      add({ id: `perm:${id}`, need: true, text: `${what} is waiting for you`, detail: `${toolName(a.tool)} · ${a.summary}`, action: { kind: 'review', target: id } }, false);
    }
    const peers = this.hub.peers(this.id);
    for (const p of peers.filter((x) => x.needsYou)) {
      add({ id: `peer:${p.id}:waiting`, need: true, text: `${p.name} needs you`, detail: 'Another session is waiting for a permission', action: { kind: 'switch', target: p.id } });
    }
    const limits = this.hub.limits();
    if (limits?.status === 'rejected') {
      const label = LIMIT_LABEL[limits.type as LimitKey] ?? 'usage';
      add({ id: `limit-rejected:${limits.type}:${minute(limits.resetsAt)}`, need: true, text: 'Usage limit reached', detail: `The ${label} limit${limits.resetsAt ? ` resets ${clock(limits.resetsAt)}` : ' is used up'}`, action: null });
    }
    for (const p of this.tracker.snapshot().procs.filter((x) => x.state === 'failed')) {
      const detail = [p.exit !== null ? `Exit code ${p.exit}` : '', p.summary ?? ''].filter(Boolean).join(' · ') || 'See the log';
      add({ id: `proc:${p.id}`, need: false, text: `${oneLine(p.command, 60)} failed`, detail, action: { kind: 'log', target: p.id } });
    }
    for (const p of peers.filter((x) => x.state === 'done')) {
      add({ id: `peer:${p.id}:done:${p.doneAt}`, need: false, text: `${p.name} finished`, detail: 'A turn ended in another session', action: { kind: 'switch', target: p.id } });
    }
    if (this.compacting) add({ id: 'compacting', need: false, text: 'Compacting the conversation', detail: 'Older turns are being summarized', action: null }, false);
    else if (this.compactError) add({ id: `compact-failed:${this.compactions}`, need: false, text: 'Compaction failed', detail: oneLine(this.compactError, 120), action: null });
    else if (this.lastCompact) {
      const c = this.lastCompact;
      const how = c.trigger === 'handoff' ? 'with a handoff' : c.trigger === 'manual' ? 'by request' : 'automatic';
      const detail = `${tok(c.pre)}${c.post !== null ? ` → ${tok(c.post)}` : ''} tokens · ${how}`;
      add({ id: `compacted:${this.compactions}`, need: false, text: 'Context compacted', detail, action: null });
    }
    if (this.ctx && this.ctx.pct >= CTX_WARN) {
      const band = Math.floor(this.ctx.pct / 10) * 10;
      const at = this.ctx.compactAt !== null ? ` · compacts at ${this.ctx.compactAt}%` : '';
      add({ id: `ctx:${band}`, need: false, text: 'Context is filling up', detail: `${this.ctx.pct}% used${at}`, action: null });
    }
    if (limits && limits.status !== 'rejected') {
      for (const [key, w] of Object.entries(limits.windows) as [LimitKey, { pct: number | null; resetsAt: number | null }][]) {
        const warned = limits.status === 'allowed_warning' && limits.type === key;
        if (!warned && (w.pct === null || w.pct < LIMIT_WARN)) continue;
        const pct = w.pct !== null ? `${Math.round(w.pct)}% used` : 'Getting close';
        add({
          id: `limit:${key}:${minute(w.resetsAt)}:${w.pct !== null ? Math.floor(w.pct / 10) : 'w'}`, need: false, text: `Close to the ${LIMIT_LABEL[key]} limit`,
          detail: `${pct}${w.resetsAt ? ` · resets ${clock(w.resetsAt)}` : ''}`, action: null,
        });
      }
    }
    return out.filter((h) => !this.dismissed.has(h.id) && !this.hub.accountDismissed(h.id));
  }

  // Pull-only in the SDK, so it is asked after each turn and each compaction.
  private async refreshContext() {
    const q = this.q;
    if (!q) return;
    try {
      const r = await q.getContextUsage({ detail: 'summary' });
      const t = r.autoCompactThreshold;
      const compactAt = !r.isAutoCompactEnabled || !t ? null : t <= 100 ? Math.round(t) : Math.round((t / r.maxTokens) * 100);
      this.ctx = { pct: Math.round(r.percentage), used: r.totalTokens, max: r.maxTokens, compactAt, handoffAt: handoffBelow(r.maxTokens) };
      this.mapChanged();
    } catch {}
  }

  // Settings changed the threshold: the meter's mark moves without waiting for a turn.
  syncHandoffAt() {
    if (!this.ctx) return;
    const next = handoffBelow(this.ctx.max);
    if (next === this.ctx.handoffAt) return;
    this.ctx = { ...this.ctx, handoffAt: next };
    this.mapChanged();
  }

  // Past the threshold at a turn end: hand off, unless a prompt may still be queued or the last compaction freed too little.
  private maybeHandoff(queued: boolean) {
    const used = this.ctx?.used ?? 0;
    const at = handoffAt();
    if (at === null || used < at) {
      this.handoffTries = 0;
      this.handoffDoc = null;
      return;
    }
    if (queued || this.status === 'working' || this.handingOff || !this.resumeId || this.handoffTries >= HANDOFF_TRIES) return;
    if (this.handoffPost !== null && used < this.handoffPost + HANDOFF_GAIN) return;
    void this.runHandoff(used);
  }

  private setHandoff(patch: Partial<HandoffState>, phase?: HandoffPhase) {
    if (!this.handoff) return;
    const now = Date.now();
    const next = { ...this.handoff, ...patch };
    if (phase) {
      next.phase = phase;
      next.steps = { ...next.steps, [phase]: now };
      if (phase === 'done' || phase === 'failed') next.endedAt = now;
    }
    this.handoff = next;
    this.mapChanged();
    this.onChange();
  }

  // Resolves on the result handle() matches to the pushed prompt.
  private handoffTurn(text: string) {
    return new Promise<void>((resolve, reject) => {
      this.handoffWait = { resolve, reject };
      this.setStatus('working');
      const uuid = randomUUID();
      capAdd(this.ownIds, uuid);
      this.ownPromptSent(text);
      this.ensureStarted().push({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null });
      this.used = true;
    });
  }

  // The card's "Try again" and the tab menu's "Hand off now": skips the tries cap and the gain guard. Returns why it can't.
  handoffNow(): string | null {
    if (this.handingOff) return 'A handoff is already running';
    if (!this.resumeId) return 'Nothing to hand off yet; send a message first';
    if (this.status === 'working' || this.pending.size || this.choices.length) return 'Session is busy, try again when it finishes';
    void this.runHandoff(this.ctx?.used ?? null);
    return null;
  }

  private async runHandoff(pre: number | null) {
    const now = Date.now();
    this.handoff = {
      phase: 'writing', steps: { writing: now }, startedAt: now, endedAt: null, pre, post: null, path: this.handoffDoc?.path ?? null, error: null, held: [],
    };
    this.handoffAbort = new AbortController();
    this.compactedNow = false;
    this.mapChanged();
    this.onChange();
    try {
      const doc = this.handoffDoc ?? (this.handoffDoc = await this.writeHandoff(this.handoffAbort));
      this.setHandoff({ path: doc.path }, 'compacting');
      await this.handoffTurn(`/compact ${COMPACT_INSTRUCTIONS}`);
      this.setHandoff({}, 'handing');
      const text = [`${HANDOFF_PREFIX}${doc.path}.`, 'Continue the work from it, together with the compaction summary above.', '', doc.text, '', '---', HANDOFF_TAIL].join('\n');
      const id = randomUUID();
      this.push({ type: 'user', id, text });
      this.chapters.start(id, 'Context handoff', Date.now());
      await this.handoffTurn(text);
      this.handoffDoc = null;
      this.handoffTries = 0;
      this.handoffPost = this.handoff?.post ?? this.ctx?.used ?? null;
      this.setHandoff({}, 'done');
    } catch (err) {
      this.handoffTries++;
      const aborted = this.handoffAbort?.signal.aborted;
      this.setHandoff({ error: aborted ? 'Stopped' : err instanceof Error ? err.message : String(err) }, 'failed');
      if (this.status === 'working' && !this.handoffWait) this.setStatus('idle');
    } finally {
      this.handoffAbort = null;
      this.handoffWait = null;
      const held = this.held;
      this.held = [];
      for (const h of held) this.send(h.text, h.pastes, h.files, h.thumbs, false, h.cid);
    }
  }

  // A throwaway fork of the transcript writes the doc. Tools are denied; the spare turns let it answer after a denied call.
  private async writeHandoff(abort: AbortController): Promise<HandoffDoc> {
    const id = this.resumeId!;
    const fork = query({
      prompt: `${HANDOFF_PROMPT}\n\nDo not call any tool or skill here. Answer with the handoff document itself, as plain text.`,
      options: {
        ...this.baseOptions(NO_ASK),
        resume: id, forkSession: true, persistSession: false, maxTurns: 3, abortController: abort, permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'Tools are off here; answer with the handoff document as plain text.' }),
      },
    });
    let text = '';
    let failure = '';
    for await (const m of fork) {
      if (m.type !== 'result') continue;
      if (m.subtype === 'success' && !m.is_error) text = fullText(m.result);
      else failure = m.subtype;
    }
    if (!text.trim()) throw new Error(failure ? `The handoff could not be written (${failure})` : 'The handoff came back empty');
    await mkdir(HANDOFF_DIR, { recursive: true });
    const path = `${HANDOFF_DIR}/handoff-${id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    await writeFile(path, text);
    return { path, text };
  }

  // Cumulative per query() call, so the latest result is the session total.
  private usage(cost: number, modelUsage: Record<string, ModelUsage> | undefined, ok: boolean) {
    if (cost > 0 || ok) this.cost = cost;
    const all = Object.values(modelUsage ?? {});
    const total = all.reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0);
    if (total) this.tokens = total;
  }

  panel(): Panel {
    return this.tracker.snapshot();
  }

  agentText(id: string) {
    return this.tracker.detail(id);
  }

  // The new client gets the whole panel; everyone gets the same serialized patches after that.
  subscribePanel(fn: (json: string) => void) {
    const full = this.flushPanel();
    this.panelListeners.add(fn);
    fn(full);
    return () => this.panelListeners.delete(fn);
  }

  // Sends listeners the rows that changed since the last send and returns the whole panel as a message.
  private flushPanel() {
    if (this.panelTimer) clearTimeout(this.panelTimer);
    this.panelTimer = null;
    const p = this.tracker.snapshot();
    const agents = diffRows(p.agents, this.sentAgents);
    const procs = diffRows(p.procs, this.sentProcs);
    const head = `{"type":"panel","sessionId":${JSON.stringify(this.id)},"active":${p.active}`;
    const any = agents.changed.length || procs.changed.length || agents.order || procs.order || p.active !== this.sentActive;
    this.sentActive = p.active;
    if (any && this.panelListeners.size) {
      const order = `${agents.order ? `,"agentOrder":${agents.order}` : ''}${procs.order ? `,"procOrder":${procs.order}` : ''}`;
      const patch = `${head},"full":false,"agents":[${agents.changed.join(',')}],"procs":[${procs.changed.join(',')}]${order}}`;
      for (const fn of this.panelListeners) fn(patch);
    }
    return `${head},"full":true,"agents":[${[...this.sentAgents.values()].join(',')}],"procs":[${[...this.sentProcs.values()].join(',')}]}`;
  }

  // Coalesced: a burst of stream events becomes one patch.
  private panelChanged() {
    this.mapChanged();
    // The dock shows background work, so the roster hears when it starts or stops.
    const bg = this.tracker.agentsRunning();
    if (bg !== this.background) {
      this.background = bg;
      this.onChange();
    }
    this.panelTimer ??= setTimeout(() => {
      this.panelTimer = null;
      // With nobody listening the sent rows go stale; the next subscribe reconciles them.
      if (this.panelListeners.size) this.flushPanel();
    }, PANEL_MS);
    this.watchPi();
  }

  // Pi runs report progress only through their Bash output, so it is read on a timer while any is open.
  private watchPi() {
    if (this.piTimer || !this.tracker.piToRead().length) return;
    this.piTimer = setInterval(() => {
      const ids = this.tracker.piToRead();
      if (!ids.length) {
        clearInterval(this.piTimer!);
        this.piTimer = null;
        return;
      }
      for (const id of ids) void this.readLog(id).then((r) => r && this.tracker.piOutput(id, r.text, r.ended));
    }, PI_POLL_MS);
  }

  // Pi gets the text through its runner's inbox; a Claude subagent through the main thread's SendMessage.
  async messageAgent(agentId: string, text: string) {
    const row = this.tracker.snapshot().agents.find((a) => a.id === agentId && !a.main);
    if (!row) return this.toast('That agent is no longer in the panel');
    if (row.kind === 'pi') {
      const inbox = this.tracker.piInbox(agentId);
      if (!inbox || !inbox.startsWith(PI_INBOX) || inbox.includes('..')) return this.toast(`${row.name} is not taking messages now`);
      try {
        await stat(inbox);
        await appendFile(inbox, JSON.stringify({ text }) + '\n');
      } catch {
        return this.toast(`${row.name} already finished`);
      }
      return this.toast(`Sent to ${row.name}`);
    }
    if (!row.taskId) return this.toast(`${row.name} cannot take messages`);
    this.send(agentNote(row.name, row.taskId, text));
  }

  async stopTask(taskId: string) {
    try {
      await this.q?.stopTask(taskId);
    } catch (err) {
      this.push({ type: 'error', message: `Stop failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Live tail from the CLI while it runs; afterwards only the output_file the SDK reported is read.
  // With redirect, a command that sends its output to its own file is read from that file when the CLI has nothing.
  async readLog(taskId: string, redirect = false): Promise<{ text: string; truncated: boolean; source: LogSource; ended: boolean; path?: string } | null> {
    const proc = this.tracker.taskOf(taskId);
    if (!proc) return null;
    const ended = proc.state !== 'running';
    const q = this.q as WithTaskOutput | null;
    let live: { text: string; truncated: boolean; source: LogSource; ended: boolean } | null = null;
    if (q?.getTaskOutput) {
      try {
        const r = await q.getTaskOutput(taskId);
        live = { text: r.output, truncated: r.truncated, source: 'live', ended };
        if (r.output) return live;
      } catch {}
    }
    const target = redirect ? redirectTarget(proc.command, this.cwd) : null;
    if (target) {
      try {
        return { ...(await tailFile(target)), source: 'redirect', ended, path: target };
      } catch {}
    }
    if (live && !ended) return live;
    const file = this.tracker.outputFile(taskId);
    if (file) {
      try {
        return { ...(await tailFile(file)), source: 'file', ended };
      } catch {}
    }
    return { text: proc.summary ?? '', truncated: false, source: 'summary', ended };
  }

  get transcriptId() {
    return this.persisted ? this.resumeId : null;
  }

  summary(): SessionSummary {
    return {
      id: this.id, name: this.name, cwd: this.cwd, branch: this.branch, state: this.dockState(),
      needsYou: this.pending.size > 0 || this.choices.length > 0, background: this.tracker.agentsRunning(), lastActive: this.lastActive, doneAt: this.doneAt, mode: this.mode, model: this.model, effort: this.effort,
      mcp: [...mcpPacks().map((p) => p.key), CHROME].map((key) => ({ key, on: this.mcp.includes(key), ...(this.mcp.includes(key) ? this.mcpState[key] : {}) })),
      mcpCount: this.mcpCount, ...(this.remote ? { remote: this.remote } : {}),
    };
  }

  private mcpCount = { on: 0, bad: false };

  subscribeMcp(fn: (json: string) => void) {
    this.mcpListeners.add(fn);
    return () => this.mcpListeners.delete(fn);
  }

  // The menu for a client that opened it; a running CLI's fresh states follow through subscribeMcp.
  async mcpMenu() {
    await this.loadCatalog();
    return this.mcpJson;
  }

  private async loadCatalog() {
    try {
      this.mcpCatalog = await catalog(this.cwd);
    } catch {}
    this.mcpChanged();
  }

  // Every server the session has or can load: packs, config files, the running CLI's list, connectors and plugins seen before, built-ins.
  private buildMcpRows(): McpRow[] {
    const live = new Map(this.mcpLive?.map((s) => [s.name, s]));
    const rows: McpRow[] = [...mcpPacks().map((p) => p.key), CHROME].map((key) => ({ key, group: 'pack', on: this.mcp.includes(key), ...(this.mcp.includes(key) ? this.mcpState[key] : {}) }));
    const added = new Set<string>();
    const add = (name: string, group: McpGroup) => {
      if (group === 'pack' || added.has(name)) return;
      added.add(name);
      const s = live.get(name);
      const state = s && { state: s.status as McpRow['state'], ...(s.error ? { error: oneLine(s.error, 200) } : {}), ...(s.tools !== undefined ? { tools: s.tools } : {}) };
      if (group === 'builtin') return void rows.push({ key: name, group, on: true, locked: true, ...state });
      // Switched off with /mcp in Claude Code: saved for the whole folder, so this menu leaves it alone.
      if (s ? s.status === 'disabled' : this.mcpCatalog?.disabled.includes(name)) return void rows.push({ key: name, group, on: false, locked: true, state: 'disabled' });
      const on = this.mcpChoices[name] ?? defaultOn(name);
      const pending = this.q && this.cliOff.has(name) === on;
      rows.push({ key: name, group, on, ...(on && !pending ? state : {}), ...(pending ? { pending: true as const } : {}) });
    };
    for (const s of this.mcpLive ?? []) add(s.name, s.name === CHROME ? 'pack' : groupOf(s.name, s.source));
    for (const n of this.mcpCatalog?.user ?? []) add(n, packOf(n) ? 'pack' : 'user');
    for (const n of this.mcpCatalog?.project ?? []) add(n, packOf(n) ? 'pack' : 'project');
    for (const [n, g] of Object.entries(seenServers())) add(n, g);
    for (const n of Object.keys(this.mcpChoices)) add(n, groupOf(n));
    for (const n of ['app', ...MODS]) add(n, 'builtin');
    // Chrome is a CLI flag, so its pack also waits for a restart.
    const chrome = rows.find((r) => r.key === CHROME);
    if (chrome && this.q && chrome.on !== this.cliChrome) Object.assign(chrome, { pending: true, state: undefined, error: undefined });
    // Packs keep their file order; the rest by name, so a toggle does not move a row.
    const packs = rows.filter((r) => r.group === 'pack');
    return [...packs, ...rows.filter((r) => r.group !== 'pack').sort((a, b) => a.key.localeCompare(b.key))];
  }

  // Clients showing the menu get the new list once; the roster only when the chip's count moved.
  private mcpChanged() {
    const rows = this.buildMcpRows();
    const phase: McpPhase | undefined = this.cliStale ? 'waiting' : this.mcpRestarting ? 'restarting' : this.q && !this.mcpLive ? 'starting' : undefined;
    const ev: ServerMessage = { type: 'mcp', sessionId: this.id, servers: rows, live: !!this.mcpLive, ...(phase ? { phase } : {}), ...(this.mcpError ? { error: this.mcpError } : {}) };
    const json = JSON.stringify(ev);
    if (json === this.mcpJson) return;
    this.mcpRows = rows;
    this.mcpJson = json;
    const on = rows.filter((r) => r.on && !r.locked && r.group !== 'builtin');
    const count = { on: on.length, bad: on.some((r) => r.state === 'failed' || (r.group === 'pack' && r.state === 'needs-auth')) };
    const moved = count.on !== this.mcpCount.on || count.bad !== this.mcpCount.bad;
    this.mcpCount = count;
    for (const fn of this.mcpListeners) fn(json);
    if (moved) this.onChange();
  }

  // Settings-loaded servers to deny when the CLI starts. Per session on purpose: toggleMcpServer saves its change for the whole folder.
  private mcpOff() {
    const names = new Set([...this.mcpRows.filter((r) => r.group !== 'pack' && !r.locked).map((r) => r.key), ...Object.keys(this.mcpChoices)]);
    return [...names].filter((n) => !(this.mcpChoices[n] ?? defaultOn(n))).sort();
  }

  // Packs apply live; the in-process app server rides along or setMcpServers would drop it. servers is absent from older clients.
  async setMcp(keys: string[], servers?: Record<string, boolean>) {
    const known = [...mcpPacks().map((p) => p.key), CHROME];
    const hadChrome = this.mcp.includes(CHROME);
    const wasOff = this.mcpOff().join('\n');
    this.mcp = known.filter((k) => keys.includes(k));
    saveMcp(this.id, this.mcp);
    this.mcpState = Object.fromEntries(Object.entries(this.mcpState).filter(([k]) => this.mcp.includes(k)));
    if (servers) {
      const fixed = new Set(this.mcpRows.filter((r) => r.locked).map((r) => r.key));
      const kept = Object.entries(servers).filter(([n, on]) => !fixed.has(n) && n !== CHROME && !packOf(n) && on !== defaultOn(n));
      this.mcpChoices = Object.fromEntries(kept.slice(0, LIVE_MAX));
      saveChoices(this.id, this.mcpChoices);
    }
    this.mcpChanged();
    this.onChange();
    // Chrome is a CLI flag and a denied server cannot come back live: both need a fresh CLI, now or once the turn ends.
    if ((hadChrome !== this.mcp.includes(CHROME) || wasOff !== this.mcpOff().join('\n')) && this.q) {
      if (!this.busy()) return void (await this.restartCli());
      this.cliStale = true;
      this.mcpChanged();
    }
    const q = this.q;
    if (!q || !this.appMcp) return;
    try {
      const res = await q.setMcpServers({ app: this.appMcp, ...serversFor(this.mcp) });
      for (const [name, error] of Object.entries(res.errors)) {
        const k = packOf(name);
        if (k) this.mcpState[k] = { state: 'failed', error };
        this.toast(`${k ?? name} did not connect: ${oneLine(error, 90)}`);
      }
    } catch (err) {
      this.push({ type: 'error', message: `MCP change failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    await this.refreshMcp();
  }

  async refreshMcp() {
    const q = this.q;
    if (!q) return;
    const rank = ['connected', 'pending', 'needs-auth', 'failed'] as const;
    try {
      const list = (await q.mcpServerStatus()).slice(0, LIVE_MAX);
      if (this.q !== q) return;
      const next: typeof this.mcpState = {};
      for (const s of list) {
        const k = s.name === CHROME ? CHROME : packOf(s.name);
        if (!k || !this.mcp.includes(k)) continue;
        const state = s.status === 'disabled' ? 'failed' : s.status;
        const cur = next[k]?.state;
        if (!cur || rank.indexOf(state) > rank.indexOf(cur)) next[k] = { state, ...(s.error ? { error: s.error } : {}) };
      }
      const packsMoved = JSON.stringify(next) !== JSON.stringify(this.mcpState);
      this.mcpState = next;
      this.mcpLive = list.map((s) => ({
        name: s.name, status: s.status, source: s.source ?? s.scope, ...(s.error ? { error: s.error } : {}), ...(s.tools ? { tools: s.tools.length } : {}),
      }));
      const shared = this.mcpLive.map((s) => [s.name, groupOf(s.name, s.source)] as [string, McpGroup]).filter(([, g]) => g === 'claudeai' || g === 'plugin');
      rememberSeen(shared, new Set(this.mcpOff()));
      this.mcpRestarting = false;
      for (const s of list) if (s.status === 'connected' || s.status === 'failed') this.authUntil.delete(s.name);
      this.mcpChanged();
      if (packsMoved) this.onChange();
    } catch {}
  }

  // Servers start as pending: ask at once, then every 1.5 s while one still connects (about 20 s at most).
  private pollMcp(q: Query, left = 14) {
    void this.refreshMcp().then(() => {
      if (this.q !== q || left <= 0) return;
      if (!this.mcpLive || this.mcpLive.some((s) => s.status === 'pending')) setTimeout(() => this.pollMcp(q, left - 1), 1500);
    });
  }

  // Starts a server's sign-in. mcpAuthenticate is on the SDK's Query class but not in its types yet.
  async mcpAuth(name: string): Promise<McpAuthReply> {
    const q = this.q as (Query & { mcpAuthenticate?: (server: string) => Promise<{ authUrl?: string; callbackExpected?: boolean } | undefined> }) | null;
    if (!q) return { error: "Claude Code isn't running for this session" };
    if (typeof q.mcpAuthenticate !== 'function') return { error: "This Claude Code version can't sign in from here" };
    try {
      const r = await q.mcpAuthenticate(name);
      const url = r?.authUrl && /^https?:\/\//.test(r.authUrl) ? r.authUrl : undefined;
      if (!url) {
        await this.refreshMcp();
        return {};
      }
      // OAuth servers call back to the CLI, which reconnects them itself; keep it alive and watch for that.
      this.authUntil.set(name, Date.now() + AUTH_WAIT_MS);
      this.watchAuth(q);
      return { url, ...(r?.callbackExpected ? {} : { manual: true as const }) };
    } catch (err) {
      return { error: oneLine(err instanceof Error ? err.message : String(err), 200) };
    }
  }

  // claude.ai connectors finish on claude.ai, so the CLI only sees the sign-in after a reconnect.
  async mcpReconnect(name: string): Promise<McpAuthReply> {
    const q = this.q;
    if (!q) return { checked: true, error: "Claude Code isn't running for this session" };
    try {
      await q.reconnectMcpServer(name);
    } catch {}
    await this.refreshMcp();
    return { checked: true };
  }

  private watchAuth(q: Query) {
    if (this.authTimer) return;
    const tick = () => {
      this.authTimer = null;
      const now = Date.now();
      for (const [n, until] of this.authUntil) if (until < now) this.authUntil.delete(n);
      if (this.q !== q || !this.authUntil.size) return;
      this.armIdle();
      void this.refreshMcp().finally(() => {
        if (this.q === q && this.authUntil.size) this.authTimer = setTimeout(tick, 3000);
      });
    };
    this.authTimer = setTimeout(tick, 3000);
  }

  // Without a CLI the menu falls back to config files and unknown states.
  private mcpGone() {
    this.mcpLive = null;
    this.mcpChanged();
  }

  // A fresh CLI picks up flags and denied servers; it warms again so the MCP menu gets live states back.
  private async restartCli() {
    this.mcpRestarting = true;
    await this.stopCli();
    this.ensureStarted();
    this.resumeRemote();
  }

  private dockState(): DockState {
    if (this.pending.size || this.choices.length) return 'waiting';
    if (this.status === 'working' || this.handingOff) return 'working';
    return this.unseenDone ? 'done' : 'idle';
  }

  // Past messages go into the log before anyone subscribes.
  seed(events: TimedEvent[]) {
    for (const e of events) this.log.push({ ...e, seq: ++this.seq, sessionId: this.id } as SeqEvent);
    this.spill();
  }

  // Never takes the last entry, which streaming text still merges into.
  private spill() {
    if (this.log.length <= LOG_MAX) return;
    const cut = trimPoint(this.log);
    if (!cut) return;
    // A streaming call's partial frames are dropped once it finishes, so they never go to disk.
    const out = this.log.splice(0, cut).filter((e) => !(e.type === 'tool' && e.partial));
    this.spilledPrompt = out.findLast((e) => e.type === 'user') ?? this.spilledPrompt;
    (this.cold ??= new ColdLog(this.id)).append(out);
  }

  // What a client that has everything up to `seq` is missing. One whose next events already went to disk
  // starts over from the in-memory tail (replace), with the cursor for paging back.
  backlog(seq: number) {
    const replace = seq === 0 || seq < (this.cold?.top ?? 0);
    const events = this.eventsAfter(replace ? 0 : seq);
    const more = !!this.cold?.size || !!this.preFrom;
    return { events, replace, older: replace && more ? (this.log[0]?.seq ?? this.seq + 1) : null };
  }

  private prehistory() {
    const from = this.preFrom;
    if (!from) return Promise.resolve(null);
    return (this.pre ??= (async () => {
      const path = await transcriptPath(this.cwd, from.tid);
      const { events } = historyOf(path ? await earlierMessages(path, from.uuid) : [], this.cwd);
      if (!events.length) return null;
      const log = new ColdLog(`${this.id}.pre`);
      log.append(events.map((e, i) => ({ ...e, seq: i + 1 - events.length, sessionId: this.id }) as SeqEvent));
      return log;
    })().catch((err) => {
      console.error('earlier history failed:', err);
      this.pre = null;
      return null;
    }));
  }

  // Pages come from the disk log, then from the transcript's segments before the resume point.
  // An id found nowhere sends nothing (older stays `before`).
  async history(before: number, until?: number, id?: string): Promise<{ events: SeqEvent[]; older: number | null }> {
    const cold = this.cold?.size ? this.cold : null;
    if (cold && before > cold.bottom) {
      const inCold = id !== undefined || until === undefined || until >= cold.bottom;
      const page = inCold ? await cold.page(before, until, id) : null;
      if (page?.found) return { events: page.events, older: page.older ?? (this.preFrom ? cold.bottom : null) };
      // The target is older still: the transcript back to it, then the rest of the disk log.
      const pre = await this.prehistory();
      const rest = pre ? await pre.page(pre.top + 1, until, id) : null;
      if (!rest?.found) return { events: [], older: before };
      const all = await cold.page(before, cold.bottom);
      return { events: [...rest.events, ...all.events], older: rest.older };
    }
    const pre = await this.prehistory();
    const page = pre ? await pre.page(Math.min(before, pre.top + 1), until, id) : null;
    return page?.found ? { events: page.events, older: page.older } : { events: [], older: id === undefined ? null : before };
  }

  async find(query: string): Promise<{ hits: FindHit[]; more: boolean }> {
    const q = query.toLowerCase();
    // A disk failure costs its own matches only; the in-memory ones still come back.
    const disk = async (log: ColdLog | null) => (log ? log.find(q).catch((err) => (console.error('history search failed:', err), [])) : []);
    const hits = [...(await disk(await this.prehistory())), ...(await disk(this.cold))];
    for (const e of this.log) {
      const h = hitOf(e, q);
      if (h) hits.push(h);
    }
    return { hits: mergeHits(hits), more: hits.reduce((a, h) => a + h.n, 0) > FIND_MAX };
  }

  subscribe(fn: (e: SeqEvent) => void) {
    this.listeners.add(fn);
    if (this.unseenDone) {
      this.unseenDone = false;
      this.onChange();
    }
    return () => this.listeners.delete(fn);
  }

  eventsAfter(seq: number) {
    const out: SeqEvent[] = [];
    for (const e of this.log) {
      if (e.seq <= seq) continue;
      const cuts = e.type === 'text' ? this.textCuts.get(e) : undefined;
      // A client that already has the start of a merged block gets only the chunks it missed.
      const from = cuts && cuts[0].seq <= seq ? cuts.find((c) => c.seq > seq)!.at : 0;
      out.push(from && e.type === 'text' ? { ...e, delta: e.delta.slice(from) } : e);
    }
    return out;
  }

  // Applies from the next CLI start; a client changing it also reloads the session.
  setStyle(style: ReplyStyle | undefined) {
    if (style) this.style = style;
  }

  // The user started typing: boot the CLI now so the first reply does not wait for it.
  warm() {
    this.usedAt = Date.now();
    if (this.queue) this.armIdle();
    else this.ensureStarted();
  }

  // A live CLI that could be stopped without losing work. Remote Control needs it running.
  get idleCli() {
    return !!this.q && !this.busy() && !this.remoteWanted;
  }

  // Returns why it could not turn on (the CLI's own reason), or null.
  async setRemoteControl(on: boolean): Promise<string | null> {
    if (!on) {
      this.remoteWanted = false;
      this.remoteGen++;
      this.setRemote(null);
      try {
        await (this.q as WithRemote | null)?.enableRemoteControl?.(false);
      } catch {}
      this.armIdle();
      this.hub.cliIdle();
      return null;
    }
    if (this.remoteWanted && this.remote?.state !== 'error') return null;
    this.remoteWanted = true;
    this.ensureStarted();
    return this.enableRemote();
  }

  private async enableRemote(): Promise<string | null> {
    const q = this.q as WithRemote | null;
    const gen = ++this.remoteGen;
    if (!q) return this.remoteFailed("Claude Code isn't running for this session");
    if (typeof q.enableRemoteControl !== 'function') return this.remoteFailed("This Claude Code version can't do Remote Control");
    this.setRemote({ state: 'connecting', url: null });
    this.remoteEnabling = true;
    try {
      const r = await q.enableRemoteControl(true, this.name);
      if (gen !== this.remoteGen || !this.remoteWanted) return null;
      this.setRemote({ state: 'on', url: remoteUrl(r) });
      return null;
    } catch (err) {
      return gen === this.remoteGen ? this.remoteFailed(oneLine(err instanceof Error ? err.message : String(err), 300)) : null;
    } finally {
      if (gen === this.remoteGen) this.remoteEnabling = false;
    }
  }

  private remoteFailed(why: string) {
    this.remoteWanted = false;
    this.setRemote(null);
    this.hub.cliIdle();
    return why;
  }

  // A restarted CLI drops the bridge; it comes back with a new session page.
  private resumeRemote() {
    if (!this.remoteWanted) return;
    this.ensureStarted();
    void this.enableRemote().then((why) => why && this.toast(`Remote Control is off: ${why}`));
  }

  private setRemote(next: RemoteState | null) {
    if (JSON.stringify(next) === JSON.stringify(this.remote)) return;
    this.remote = next;
    this.onChange();
  }

  private onBridgeState(state: unknown, detail: unknown, kind: unknown) {
    if (!this.remoteWanted || !this.remote) return;
    const next = bridgeState(state, detail, kind, this.remote);
    // Until enable answers, only a final failure is news; the answer brings the url.
    if (this.remoteEnabling && next.state !== 'error') return;
    if (next.state === 'error') {
      this.remoteWanted = false;
      this.remoteGen++;
      this.toast(`Remote Control stopped: ${next.error}`);
    }
    this.setRemote(next);
  }

  private busy() {
    return this.status === 'working' || this.handingOff || this.pending.size > 0 || this.choices.length > 0 || this.tracker.hasRunning();
  }

  // Pasted blocks travel with the prompt as plain text, ahead of what was typed; files go first as their own blocks.
  // cid is the client's id for the message: the echo carries it, and a retry of an already sent one is dropped.
  send(text: string, pastes: string[] = [], files: Upload[] = [], thumbs: (string | null)[] = [], now = false, cid?: string, seen?: StretchSeen) {
    if (cid && this.echoed(cid)) return;
    if (this.handingOff && this.handoff) {
      if (cid && this.held.some((h) => h.cid === cid)) return;
      this.held.push({ text, pastes, files, thumbs, cid });
      const preview = oneLine(text || files.map((f) => f.name).join(', ') || 'Pasted text', 80);
      this.handoff = { ...this.handoff, held: [...this.handoff.held, preview] };
      this.mapChanged();
      return;
    }
    if (seen) this.stretchNote = noteOf(seen.opened, seen.unopened);
    if (this.status === 'working') this.sentBusy = true;
    else this.stopRequested = false;
    this.hub.phone.cancel(this.id);
    const id = (cid as UUID | undefined) ?? randomUUID();
    const shown: Attachment[] = files.map((f, i) => {
      const src = f.kind === 'image' ? imageUrl(f.mime, f.data) : null;
      const thumb = thumbs[i] ? dataUrlImage(thumbs[i]!) : null;
      return { name: f.name, kind: f.kind, ...(thumb ? { thumb } : {}), ...(src ? { src } : {}) };
    });
    const queued = this.status === 'working';
    if (queued) {
      this.queuedIds.add(id);
      this.queuedMsgs.set(id, { text, pastes, files, thumbs });
    }
    this.push({ type: 'user', id, text, ...(pastes.length ? { pastes } : {}), ...(shown.length ? { files: shown } : {}), ...(queued ? { queued } : {}) });
    const typed = [...pastes, text].filter((t) => t.trim()).join('\n\n');
    const content: string | ContentBlockParam[] = files.length ? [...files.map(fileBlock), ...(typed ? [{ type: 'text' as const, text: typed }] : [])] : typed;
    const label = text || (files.length ? files.map((f) => f.name).join(', ') : 'Pasted text');
    this.chapters.start(id, label, Date.now());
    this.changes.startTurn(id);
    this.activity = '';
    capAdd(this.ownIds, id);
    this.ownPromptSent(typed);
    // The uuid comes back in command_lifecycle, which says when the CLI actually picks the message up.
    this.ensureStarted().push({ type: 'user', uuid: id, message: { role: 'user', content }, parent_tool_use_id: null, ...(now ? { priority: 'now' as const } : {}) });
    this.used = true;
    this.resumeId ??= this.id;
    // A new session is named after its first prompt instead of its folder.
    if (!this.named) {
      this.named = true;
      this.name = shortTitle(label);
    }
    this.tracker.turnStart();
    this.setStatus('working');
    this.touch();
  }

  // A retry follows its original closely, so only the recent end of the log is searched.
  private echoed(cid: string) {
    for (let i = this.log.length - 1; i >= Math.max(0, this.log.length - 500); i--) {
      const e = this.log[i];
      if (e.type === 'user' && e.id === cid) return true;
    }
    return false;
  }

  async rename(title: string) {
    this.name = title;
    this.named = true;
    this.userRenamed = true;
    this.onChange();
    if (this.persisted) await renameSession(this.resumeId!, title);
    else this.pendingTitle = title;
  }

  answerPermission(id: string, allow: boolean, reply?: AskReply) {
    this.pending.get(id)?.(allow, reply);
  }

  async interrupt() {
    this.tracker.markInterrupted();
    this.stopRequested = true;
    this.cancelChoices();
    this.handoffAbort?.abort();
    try {
      await this.q?.interrupt();
    } catch (err) {
      this.push({ type: 'error', message: `Interrupt failed: ${String(err)}` });
    }
  }

  async setMode(mode: Mode) {
    this.mode = mode;
    if (mode !== 'plan') this.beforePlan = mode;
    this.onChange();
    await this.control(() => this.q?.setPermissionMode(mode), 'Permission mode');
  }

  async setModel(model: string, effort: Effort) {
    const modelChanged = model !== this.model;
    const effortChanged = effort !== this.effort;
    this.model = model;
    this.effort = effort;
    this.onChange();
    if (modelChanged) await this.control(() => this.q?.setModel(model), 'Model');
    if (effortChanged) await this.control(() => this.q?.applyFlagSettings({ effortLevel: effort }), 'Effort');
  }

  // Resolves once the CLI process is gone.
  close() {
    if (this.piTimer) clearInterval(this.piTimer);
    this.cancelChoices();
    this.hub.phone.cancel(this.id);
    for (const a of this.forks) a.abort();
    this.handoffAbort?.abort();
    this.handoffWait?.reject(new Error('The session closed'));
    revokeAll(this.id);
    this.cold?.drop();
    void this.pre?.then((p) => p?.drop());
    this.remoteWanted = false;
    return this.stopCli();
  }

  // Stops only the CLI process; the session stays open and the next intent or send starts a fresh one.
  private stopCli() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.surface?.stop();
    this.surface = null;
    const q = this.q;
    this.q = null;
    this.queue?.close();
    this.queue = null;
    q?.close();
    this.mcpGone();
    // The bridge dies with the process; resumeRemote brings it back when it is still wanted.
    this.remoteGen++;
    if (this.remote) this.setRemote(this.remoteWanted ? { state: 'connecting', url: null } : null);
    return this.done ?? Promise.resolve();
  }

  private async control(fn: () => Promise<unknown> | undefined, what: string) {
    try {
      await fn();
    } catch (err) {
      this.push({ type: 'error', message: `${what} change failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private touch() {
    this.lastActive = this.usedAt = this.wroteAt = Date.now();
    this.armIdle();
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = this.q ? setTimeout(() => this.release(), this.used ? IDLE_MS : WARM_MS) : null;
  }

  // Stops the CLI so the next message starts one that re-reads the prompt, settings, skills and MCP config. Returns why it can't, if busy.
  async reload(): Promise<string | null> {
    if (this.status === 'working' || this.handingOff || this.pending.size || this.choices.length) return 'Session is busy, try again when it finishes';
    if (this.tracker.hasRunning()) return 'Agents are still running, try again later';
    await this.stopCli();
    this.resumeRemote();
    return null;
  }

  // Frees the CLI process when nothing depends on it; the next send resumes the transcript.
  release() {
    if (!this.q) return;
    if (this.busy()) return this.touch();
    if (this.remoteWanted) return this.armIdle();
    void this.stopCli();
  }

  private push(e: ServerEvent) {
    // Keep order: buffered text goes out before whatever comes next.
    this.flushText();
    this.emit(e);
  }

  private emit(e: ServerEvent) {
    const last = this.log[this.log.length - 1];
    const merge = e.type === 'text' && last?.type === 'text' && last.id === e.id;
    // Only a block's first chunk carries at; text chunks are the most frequent events.
    const ev = { ...e, seq: ++this.seq, sessionId: this.id } as SeqEvent;
    if (!merge) ev.at = Date.now();
    if (merge && ev.type === 'text' && last.type === 'text') {
      // Streamed chunks of one block share a log entry, so a reopen replays one event instead of thousands.
      const cuts = this.textCuts.get(last) ?? [{ seq: last.seq, at: 0 }];
      cuts.push({ seq: ev.seq, at: last.delta.length });
      const merged = { ...last, delta: last.delta + ev.delta, seq: ev.seq };
      this.textCuts.set(merged, cuts);
      this.log[this.log.length - 1] = merged;
    } else {
      this.log.push(ev);
      this.spill();
    }
    for (const fn of this.listeners) fn(ev);
  }

  private setStatus(state: Status) {
    if (state === this.status) return;
    this.status = state;
    this.mapChanged();
    this.surface?.invalidate();
    this.push({ type: 'status', state });
    this.tracker.statusChanged(state === 'working');
    this.onChange();
    this.panelChanged();
    // Restarts right away (not on the next send) so the MCP menu shows the change applied.
    if (this.cliStale && !this.busy()) {
      this.cliStale = false;
      void this.restartCli();
    }
  }

  private setActivity(text: string) {
    if (text === this.activity) return;
    this.activity = text;
    this.mapChanged();
  }

  private appendText(id: string, delta: string) {
    this.textBuf.set(id, (this.textBuf.get(id) ?? '') + delta);
    this.flushTimer ??= setTimeout(() => this.flushText(), FLUSH_MS);
  }

  private flushText() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.textBuf.size) return;
    const batch = [...this.textBuf];
    this.textBuf.clear();
    for (const [id, delta] of batch) this.emit({ type: 'text', id, delta });
  }

  // A streaming rich tool's input so far; replaced in the log by the final call.
  private partial(id: string, name: string, input: object) {
    const ev = this.tools.call(id, name, input, true);
    if (!ev) return;
    // render_ui streams its html, which is not shown until done; unchanged frames are not resent.
    const json = JSON.stringify(ev);
    if (this.lastPartial.get(id) === json) return;
    this.lastPartial.set(id, json);
    this.push(ev);
  }

  private dropPartials(id: string) {
    for (const [k, st] of this.streaming) {
      if (st.id !== id) continue;
      if (st.timer) clearTimeout(st.timer);
      this.streaming.delete(k);
    }
    this.log = this.log.filter((e) => !(e.type === 'tool' && e.partial && e.id === id));
    this.lastPartial.delete(id);
  }

  private stopStreaming() {
    for (const st of this.streaming.values()) if (st.timer) clearTimeout(st.timer);
    this.streaming.clear();
  }

  // ask_choice handler: waits for a click in the UI, the abort signal, or an interrupt.
  private choose: ChoiceBroker = (question, count, signal, toolUseId) => {
    const fits = (p: AskPick) => typeof p === 'string' || (typeof p === 'number' && p >= 0 && p < count);
    return this.waitFor(APP_TOOLS.choice, question, oneLine(question, 120), fits, signal, toolUseId) as Promise<number | string | null>;
  };

  // ask_round handler: same wait as ask_choice, answered once for the whole round.
  private askRound: RoundBroker = (round, signal, toolUseId) => {
    const counts = round.questions.map((q) => q.options.length);
    const fits = (p: AskPick) => Array.isArray(p) && p.length === counts.length && p.every((a, i) => a.option === null || a.option < counts[i]);
    const summary = oneLine(round.title || round.questions.map((q) => q.title).join(' · '), 120);
    return this.waitFor(APP_TOOLS.round, roundKey(round), summary, fits, signal, toolUseId) as Promise<RoundPick[] | null>;
  };

  private waitFor = (tool: string, question: string, summary: string, fits: (p: AskPick) => boolean, signal: AbortSignal | undefined, toolUseId: string | undefined) =>
    new Promise<AskPick | null>((resolve) => {
      let id = toolUseId ?? null;
      if (id) this.unclaimed = this.unclaimed.filter((u) => u.id !== id);
      else {
        const k = this.unclaimed.findIndex((u) => u.tool === tool && u.question === question);
        if (k >= 0) id = this.unclaimed.splice(k, 1)[0].id;
      }
      const w: ChoiceWait = {
        id, tool, question, summary, fits,
        resolve: (pick) => {
          signal?.removeEventListener('abort', onAbort);
          this.choices = this.choices.filter((c) => c !== w);
          if (w.id) this.asks.delete(w.id);
          // "Asking you a question" would read as still waiting once answered.
          this.activity = '';
          this.waitEnded();
          this.mapChanged();
          this.onChange();
          resolve(pick);
        },
      };
      const onAbort = () => w.resolve(null);
      if (signal?.aborted) return resolve(null);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.choices.push(w);
      this.waitStarted(WAIT.question);
      this.onChange();
      if (id) this.claim(w, id);
    });

  private claim(w: ChoiceWait, id: string) {
    w.id = id;
    this.asks.set(id, { tool: w.tool, summary: w.summary });
    this.mapChanged();
    const early = this.early.get(id);
    if (early !== undefined) {
      this.early.delete(id);
      if (w.fits(early)) w.resolve(early);
    }
  }

  private choiceSeen(id: string, tool: string, question: string) {
    const w = this.choices.find((c) => c.id === null && c.tool === tool && c.question === question);
    if (w) this.claim(w, id);
    else this.unclaimed.push({ id, tool, question });
  }

  // cancelAsyncMessage is not in the SDK types yet; when it fails, the message simply stays queued.
  async unqueue(id: string, then: 'remove' | 'now') {
    const msg = this.queuedMsgs.get(id);
    const q = this.q as (Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }) | null;
    if (!msg || !q?.cancelAsyncMessage) return;
    const ok = await q.cancelAsyncMessage(id).catch(() => false);
    if (!ok) return this.toast('Claude already read that message');
    this.queuedIds.delete(id);
    this.queuedMsgs.delete(id);
    this.push({ type: 'unqueued', id });
    if (then === 'now') this.send(msg.text, msg.pastes, msg.files, msg.thumbs, true);
  }

  // pick is an option index or the user's own words, or a round's answers.
  answerChoice(id: string, pick: AskPick) {
    const w = this.choices.find((c) => c.id === id);
    if (!w) {
      if (this.unclaimed.some((u) => u.id === id)) this.early.set(id, pick);
      return;
    }
    if (w.fits(pick)) w.resolve(pick);
  }

  private cancelChoices() {
    for (const w of [...this.choices]) w.resolve(null);
    this.unclaimed = [];
    this.early.clear();
  }

  // phone-ping: a permission or question still unanswered after the delay pushes to the phone.
  private waitStarted(title: string) {
    this.hub.phone.schedule(this.id, title, (t) => this.toast(t));
  }

  private waitEnded() {
    if (!this.pending.size && !this.choices.length) this.hub.phone.cancel(this.id);
  }

  // tldr mod: a long answer gets a short summary on top; never awaited.
  private async summarize(textId: string, answer: string) {
    try {
      const r = await tldr(fullText(answer));
      if (r) this.push({ type: 'tldr', id: textId, ...r });
    } catch (err) {
      console.error(`tldr failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // error-translator mod: a failed Bash call the user did not deny or interrupt gets a plain explanation.
  private bashFinished(id: string, content: unknown, isError: boolean) {
    const command = this.bashCalls.get(id);
    this.bashCalls.delete(id);
    const denied = this.denied.delete(id);
    if (command === undefined || !isError || denied) return;
    const output = resultText(content);
    if (/interrupted by user/i.test(output)) return;
    explainError(command, output)
      .then((text) => text && this.push({ type: 'tool-note', id, text }))
      .catch((err) => console.error(`error note failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // explica mod: a throwaway fork of the transcript answers one side question, with tools denied.
  async explain(req: ExplainRequest, deep: boolean, reply: (e: ExplainEvent) => void) {
    const abort = new AbortController();
    this.forks.add(abort);
    try {
      const answer: Fork = deep ? (prompt, a) => this.forkAnswer(prompt, a) : (prompt, a) => answerLight(this.recentText(), prompt, a);
      await explain(this.id, req, answer, abort, reply);
    } finally {
      this.forks.delete(abort);
    }
  }

  // The conversation's last user and Claude messages, newest kept whole, up to a character budget.
  private recentText(budget = RECENT_CHARS) {
    const order: string[] = [];
    const msgs = new Map<string, { who: string; text: string }>();
    for (const e of this.spilledPrompt ? [this.spilledPrompt, ...this.log] : this.log) {
      if (e.type === 'user') {
        order.push(e.id);
        msgs.set(e.id, { who: 'User', text: e.text });
      } else if (e.type === 'text') {
        const m = msgs.get(e.id);
        if (m) m.text += e.delta;
        else {
          order.push(e.id);
          msgs.set(e.id, { who: 'Claude', text: e.delta });
        }
      }
    }
    const out: string[] = [];
    for (let i = order.length - 1; i >= 0 && budget > 0; i--) {
      const m = msgs.get(order[i])!;
      const line = `${m.who}: ${(m.who === 'Claude' ? fullText(m.text) : m.text).trim()}`;
      out.unshift(line.length > budget ? `${m.who}: …${line.slice(-budget)}` : line);
      budget -= line.length;
    }
    return out.join('\n\n') || '(no messages yet)';
  }

  private async forkAnswer(prompt: string, abort: AbortController) {
    if (!this.persisted || !this.resumeId) throw new Error('Nothing to explain yet: the conversation has not started');
    const fork = query({
      prompt,
      options: {
        ...this.baseOptions(NO_ASK),
        // A fork inherits rules that may open with a tool call (e.g. a progress report); the denial plus a spare turn lets it answer.
        resume: this.resumeId, forkSession: true, persistSession: false, maxTurns: 3, abortController: abort, permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'No tools in the explain panel. Answer in text only.' }),
      },
    });
    const tried: string[] = [];
    let said = '';
    for await (const m of fork) {
      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const b of m.message.content) {
          if (b.type === 'tool_use') tried.push(b.name);
          else if (b.type === 'text' && b.text.trim()) said = b.text;
        }
      }
      if (m.type !== 'result') continue;
      // The fork shares the live prompt, stretch guide included; the explain panel shows plain text.
      const text = fullText(m.subtype === 'success' && !m.is_error ? m.result.trim() || said : said);
      if (text.trim()) return text;
      console.error(`explain fork gave no text (${m.subtype}${tried.length ? `; tried ${tried.join(', ')}` : ''})`);
      throw new Error(m.subtype === 'success' ? 'The answer came back empty' : m.subtype);
    }
    throw new Error(abort.signal.aborted ? 'Stopped' : 'No answer');
  }

  // The replay a mcp__replay__open call of this session named; nothing else can be granted.
  // Fires after each successful file tool call, subagents included (agent_id is their task id).
  private fileHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    const row = input.agent_id ? this.tracker.rowOfTask(input.agent_id) ?? `task:${input.agent_id}` : 'main';
    try {
      this.changes.record({ id: row, main: !input.agent_id }, input.tool_name, input.tool_input, input.tool_response);
    } catch {}
    return {};
  };

  // Rides on every user message; read at call time so a prompt.ts edit applies on the next message.
  private promptHook: HookCallback = async (input) => {
    const own = input.hook_event_name !== 'UserPromptSubmit' || this.ownPrompt(input.prompt);
    if (this.remoteWanted && !own) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PHONE_NOTE } };
    const note = this.stretchNote;
    this.stretchNote = null;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note ? `${visualReminder}\n\n${note}` : visualReminder } };
  };

  // Only the end of each prompt is kept: enough to match it, small with large pastes.
  private ownPromptSent(text: string) {
    this.ownTexts.push(text.trim().slice(-500));
    if (this.ownTexts.length > OWN_TEXTS) this.ownTexts.shift();
  }

  // The hook only gets the text: a prompt matching one sent from here is ours (and is dropped); the rest came over Remote Control.
  private ownPrompt(prompt: string) {
    const i = this.ownTexts.findIndex((t) => !t || prompt.includes(t));
    if (i < 0) return false;
    this.ownTexts.splice(i, 1);
    return true;
  }

  // Subagents report their steps so the Work panel can check them off; no decision, so permissions stay as they are.
  private agentHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const ti = input.tool_input as Record<string, unknown> | null;
    if (!ti || typeof ti.prompt !== 'string' || ti.prompt.includes(PROGRESS_TOOL)) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, prompt: ti.prompt + PROGRESS_NOTE } } };
  };

  changeDetail(id: string, path: string) {
    return this.changes.detail(id, path);
  }

  async replay(id: string): Promise<ReplayInfo> {
    const path = this.tools.replayPath(id);
    if (!path) return { title: 'Replay', pages: [], error: 'This replay is not part of the session' };
    return loadReplay(path, this.id);
  }

  // The page text of a replay this session opened, for its spoken summary.
  replayText(id: string) {
    const path = this.tools.replayPath(id);
    return path ? readReplayText(path) : Promise.resolve(null);
  }

  async watchPage(before?: number): Promise<WatchPage> {
    const tid = this.transcriptId;
    const page = before ?? null;
    if (!tid) return { entries: [], page, before: null };
    if (this.watch?.id !== tid) this.watch = new WatchTimeline(this.cwd, tid);
    try {
      return await this.watch.page(before, this.status === 'working');
    } catch (err) {
      return { entries: [], page, before: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private canUseTool: CanUseTool = (toolName, input, { signal, title, defaultToNo, toolUseID, agentID }) =>
    new Promise<PermissionResult>((resolve) => {
      const id = toolUseID || randomUUID();
      const finish = (allow: boolean, reply?: AskReply, elsewhere = false) => {
        this.pending.delete(id);
        this.asks.delete(id);
        // An allowed command keeps its "Running …" line; an answered question does not.
        if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') this.activity = '';
        if (!allow && !elsewhere) this.denied.add(id);
        this.waitEnded();
        this.mapChanged();
        this.tracker.permission(id, agentID, false);
        signal.removeEventListener('abort', onAbort);
        const result = this.decide(toolName, input, allow, reply);
        this.push({ type: 'permission-resolved', id, allow, ...(reply ? { reply } : {}), ...(elsewhere ? { elsewhere } : {}) });
        this.onChange();
        this.touch();
        resolve(result);
      };
      // With Remote Control on, the CLI cancels this ask when the phone answers it first.
      const onAbort = () => finish(false, undefined, this.remoteWanted && !this.stopRequested);
      if (signal.aborted) return finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, finish);
      this.waitStarted(toolName === 'AskUserQuestion' ? WAIT.question : toolName === 'ExitPlanMode' ? WAIT.plan : WAIT.other);
      const summary = summarizeFor(this.cwd, toolName, input);
      this.asks.set(id, { tool: toolName, summary });
      this.mapChanged();
      this.tracker.permission(id, agentID, true);
      const detail = diffDetail(this.cwd, toolName, input);
      const questions = toolName === 'AskUserQuestion' ? questionsOf(input) : undefined;
      // The CLI puts the plan file's text into the input before asking.
      const plan = toolName === 'ExitPlanMode' ? (typeof input.plan === 'string' ? input.plan : '') : undefined;
      this.push({
        type: 'permission', id, tool: displayTool(toolName), summary, ...(title ? { title } : {}), ...(defaultToNo ? { defaultToNo } : {}), ...(detail ? { detail } : {}),
        ...(questions ? { questions } : {}), ...(plan !== undefined ? { plan, back: this.mode === 'plan' ? this.beforePlan : this.mode } : {}),
      });
      this.onChange();
    });

  // Answers go back inside the input; an approved plan switches the mode in the same reply.
  private decide(tool: string, input: Record<string, unknown>, allow: boolean, reply?: AskReply): PermissionResult {
    if (!allow) {
      if (tool === 'ExitPlanMode' && reply?.feedback) return { behavior: 'deny', message: `The user wants to keep planning. Revise the plan with this feedback: ${reply.feedback}` };
      return { behavior: 'deny', message: tool === 'AskUserQuestion' ? 'The user chose not to answer.' : 'The user denied this action.' };
    }
    if (tool === 'AskUserQuestion') return { behavior: 'allow', updatedInput: { ...input, answers: reply?.answers ?? {} } };
    if (tool === 'ExitPlanMode' && reply?.mode) {
      this.mode = reply.mode;
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: reply.mode, destination: 'session' }] };
    }
    return { behavior: 'allow', updatedInput: input };
  }

  // Shared with the handoff fork, so its prompt prefix (system prompt, tools) matches the live one and hits the cache.
  private baseOptions(brokers: Brokers): Options {
    const off = this.mcpOff();
    return {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.style === 'stretch' ? `${visualPrompt}\n\n${stretchGuide}` : visualPrompt },
      // A fresh server per process: an MCP server instance connects to one transport only.
      mcpServers: { app: appServer(brokers) },
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      ...(process.env.CW_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CW_CLAUDE_BIN } : {}),
      // Only the mods whose tools this app renders; a flag layer beats the user settings' env. CLAUDE_WEB tells skills they render in a browser.
      // deniedMcpServers merges from every layer, so it switches settings-loaded servers off for this process only.
      extraArgs: {
        settings: JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: WEB_MODS, CLAUDE_WEB: '1' }, ...(off.length ? { deniedMcpServers: off.map((serverName) => ({ serverName })) } : {}) }),
        ...(this.mcp.includes(CHROME) ? { chrome: null } : {}),
      },
    };
  }

  private ensureStarted() {
    if (this.queue) return this.queue;
    const queue = new PromptQueue();
    const base = this.baseOptions({ choose: this.choose, round: this.askRound });
    this.appMcp = base.mcpServers!.app;
    this.cliOff = new Set(this.mcpOff());
    this.cliChrome = this.mcp.includes(CHROME);
    this.cliStyle = this.style;
    this.mcpError = null;
    const options: Options = {
      ...base,
      mcpServers: { ...base.mcpServers, ...serversFor(this.mcp) },
      allowedTools: APP_TOOL_NAMES,
      includePartialMessages: true,
      // Subagent text feeds the agents panel; the conversation still skips it.
      forwardSubagentText: true,
      // The agents panel stops tasks one by one, so Esc only aborts the turn instead of killing background agents.
      perTaskStopAffordance: true,
      canUseTool: this.canUseTool,
      hooks: {
        PreToolUse: [{ matcher: '^(Agent|Task)$', hooks: [this.agentHook] }],
        PostToolUse: [{ matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [this.fileHook] }],
        UserPromptSubmit: [{ hooks: [this.promptHook] }],
      },
      permissionMode: this.mode,
      // Lets the mode menu switch to Bypass at runtime.
      allowDangerouslySkipPermissions: true,
      ...(this.resumeId ? { resume: this.resumeId } : { sessionId: this.id }),
    };
    this.queue = queue;
    this.q = query({ prompt: queue, options });
    this.done = this.consume(this.q);
    void this.loadCommands(this.q);
    const surface = new PluginSurface(this.q, {
      tree: (t) => {
        if (this.surface !== surface) return;
        this.above = t;
        this.mapChanged();
      },
      ask: (a) => this.askComposer(a),
      working: () => this.status === 'working',
    });
    this.surface = surface;
    void surface.start();
    this.pollMcp(this.q);
    this.used = false;
    this.usedAt = Date.now();
    this.armIdle();
    this.hub.cliIdle();
    this.mcpChanged();
    return queue;
  }

  private async consume(q: Query) {
    try {
      for await (const m of q) this.handle(m);
    } catch (err) {
      if (this.q === q) {
        this.push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        // A CLI that died before reporting its servers failed to start, as far as the MCP menu goes.
        if (!this.mcpLive) this.mcpError = oneLine(err instanceof Error ? err.message : String(err), 200);
      }
    } finally {
      // A released query is already replaced or gone; only a crash resets state here.
      if (this.q === q) {
        this.surface?.stop();
        this.surface = null;
        this.q = null;
        this.queue = null;
        this.handoffWait?.reject(new Error('Claude Code stopped'));
        this.mcpRestarting = false;
        this.setStatus('idle');
        this.mcpGone();
        if (this.remote) this.toast('Remote Control stopped: Claude Code exited');
        this.remoteWanted = false;
        this.remoteGen++;
        this.setRemote(null);
      }
      // Skipped when a newer process already took over.
      if (!this.q) this.tracker.processEnded();
    }
  }

  // A rename made before the transcript existed is saved now.
  private markPersisted() {
    this.persisted = true;
    const title = this.pendingTitle;
    this.pendingTitle = null;
    if (title) renameSession(this.resumeId!, title).catch((err) => this.push({ type: 'error', message: `Rename failed: ${String(err)}` }));
  }

  // A turn the web did not send: its uuid shows on the lifecycle start or on the reply, never as a user message.
  private remoteTurn(m: SDKMessage) {
    if (!this.remoteWanted) return null;
    const raw = m as unknown as { type: string; state?: string; command_uuid?: string; user_message_uuid?: string; parent_tool_use_id?: string | null };
    const id = raw.type === 'command_lifecycle' ? (raw.state === 'started' ? raw.command_uuid : undefined) : raw.type === 'assistant' && !raw.parent_tool_use_id ? raw.user_message_uuid : undefined;
    if (!id || this.ownIds.has(id) || this.seenTurns.has(id)) return null;
    capAdd(this.seenTurns, id);
    return id;
  }

  // Holds the stream while the phone's message is read, then replays it, so the prompt lands before its reply.
  private async phoneArrived(uuid: string) {
    try {
      const msg = await phoneMessage(this.cwd, this.resumeId ?? this.id, uuid);
      if (msg) this.phoneStart(uuid, msg);
    } catch {}
    const held = this.phoneHold ?? [];
    this.phoneHold = null;
    for (const m of held) this.handle(m);
  }

  private phoneStart(id: string, msg: PhoneMessage) {
    if (this.status !== 'working') this.stopRequested = false;
    this.push({ type: 'user', id, text: msg.text, ...(msg.files.length ? { files: msg.files } : {}), phone: true });
    const label = msg.text || msg.files.map((f) => f.name).join(', ');
    this.chapters.start(id, label, Date.now());
    this.changes.startTurn(id);
    this.activity = '';
    this.used = true;
    this.phoneTurn = true;
    this.resumeId ??= this.id;
    if (!this.named) {
      this.named = true;
      this.name = shortTitle(label);
    }
    this.tracker.turnStart();
    this.setStatus('working');
    this.touch();
  }

  private handle(m: SDKMessage) {
    if (this.phoneHold) return void this.phoneHold.push(m);
    const turn = this.remoteTurn(m);
    if (turn) {
      this.phoneHold = [m];
      void this.phoneArrived(turn);
      return;
    }
    this.tracker.handle(m);
    const life = m as unknown as { type: string; command_uuid?: string; state?: string };
    if (life.type === 'command_lifecycle') {
      if (life.state !== 'queued' && life.command_uuid && this.queuedIds.delete(life.command_uuid)) {
        this.queuedMsgs.delete(life.command_uuid);
        this.push({ type: 'delivered', id: life.command_uuid });
      }
      return;
    }
    switch (m.type) {
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev.type === 'message_start') {
          this.currentMsgId = ev.message.id;
          this.stopStreaming();
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.currentMsgId) {
          this.streamedIds.add(this.currentMsgId);
          this.lastTextId = `${this.currentMsgId}:${ev.index}`;
          this.appendText(this.lastTextId, ev.delta.text);
          this.chapters.text(ev.delta.text);
          this.setActivity('Writing a reply');
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use' && STREAMED.has(ev.content_block.name)) {
          const b = ev.content_block;
          this.streaming.set(ev.index, { id: b.id, name: b.name, json: '', timer: null });
          this.partial(b.id, b.name, {});
          this.setActivity(describeTool(this.cwd, b.name, {}));
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
          const st = this.streaming.get(ev.index);
          if (!st) return;
          st.json += ev.delta.partial_json;
          st.timer ??= setTimeout(() => {
            st.timer = null;
            if (this.streaming.get(ev.index) !== st) return;
            const input = parsePartial(st.json);
            if (input && typeof input === 'object') this.partial(st.id, st.name, input);
          }, PARTIAL_MS);
        } else if (ev.type === 'content_block_stop') {
          const st = this.streaming.get(ev.index);
          if (st?.timer) clearTimeout(st.timer);
          this.streaming.delete(ev.index);
        }
        return;
      }
      case 'assistant': {
        this.touch();
        for (const block of m.message.content) if (block.type === 'tool_use' && !PLUMBING.has(block.name)) this.chapters.tool();
        if (m.parent_tool_use_id) return;
        if (m.error) this.push({ type: 'error', message: `Assistant error: ${m.error}` });
        const msg = m.message;
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            this.dropPartials(block.id);
            const ev = this.tools.call(block.id, block.name, block.input);
            if (ev) this.push(ev);
            if (block.name === APP_TOOLS.choice) this.choiceSeen(block.id, block.name, String((block.input as { question?: unknown })?.question ?? ''));
            if (block.name === APP_TOOLS.round) this.choiceSeen(block.id, block.name, roundKey(block.input));
            if (block.name === 'Bash') this.bashCalls.set(block.id, String((block.input as { command?: unknown })?.command ?? ''));
            if (!PLUMBING.has(block.name)) this.setActivity(describeTool(this.cwd, block.name, block.input));
          } else if (block.type === 'text' && !this.streamedIds.has(msg.id)) {
            if (msg.model === '<synthetic>' && this.localSeen.has(m.uuid)) continue;
            if (msg.model === '<synthetic>') this.localSeen.add(m.uuid);
            // Fallback for text that never arrived as deltas.
            this.lastTextId = `${msg.id}:${m.uuid}`;
            // <synthetic> marks a local command's output (/usage, /context), not a model reply.
            this.push({ type: 'text', id: this.lastTextId, delta: msg.model === '<synthetic>' ? localOutput(block.text) : block.text });
            this.chapters.text(block.text);
          }
        }
        return;
      }
      case 'user': {
        if (m.parent_tool_use_id || !Array.isArray(m.message.content)) return;
        for (const b of m.message.content) {
          if (b.type !== 'tool_result') continue;
          const ev = this.tools.result(b.tool_use_id, b.content, !!b.is_error);
          if (ev) this.push(ev);
          this.bashFinished(b.tool_use_id, b.content, !!b.is_error);
        }
        return;
      }
      case 'result': {
        // The /compact command's own result is not a turn of the conversation.
        if (this.handoff?.phase === 'compacting' && this.handoffWait) {
          this.usage(m.total_cost_usd, m.modelUsage, m.subtype === 'success');
          const w = this.handoffWait;
          this.handoffWait = null;
          if (this.compactedNow) w.resolve();
          else w.reject(new Error(this.compactError ?? (m.subtype === 'success' ? 'The compaction did not run' : 'The compaction was stopped')));
          return;
        }
        this.stopStreaming();
        this.tracker.turnEnd(m.subtype === 'success', m.modelUsage);
        this.changes.flush();
        this.usage(m.total_cost_usd, m.modelUsage, m.subtype === 'success');
        this.activity = '';
        const job = this.chapters.turnEnd(Date.now());
        if (job) this.requestTitle(job);
        const queued = this.sentBusy;
        this.sentBusy = false;
        void this.refreshContext().then(() => this.maybeHandoff(queued));
        if (this.handoff?.phase === 'handing' && this.handoffWait) {
          const w = this.handoffWait;
          this.handoffWait = null;
          if (m.subtype === 'success') w.resolve();
          else w.reject(new Error('The hand-over turn was stopped'));
        }
        this.push({ type: 'turn-end', ok: m.subtype === 'success' && !this.stopRequested, subtype: m.subtype });
        this.stopRequested = false;
        const textId = this.lastTextId;
        this.lastTextId = null;
        // A local command (/usage, /context) answers without a model turn: no recap or summary for it.
        if (m.subtype === 'success' && !m.is_error && m.num_turns > 0) {
          if (textId && this.cliStyle !== 'stretch') void this.summarize(textId, m.result);
          // A turn sent from the phone already shows its end there.
          if (!this.phoneTurn) this.hub.phone.turnEnded(m.duration_ms, (t) => this.toast(t));
        }
        this.phoneTurn = false;
        if (!this.persisted) this.markPersisted();
        if (!this.listeners.size) this.unseenDone = true;
        this.doneAt = Date.now();
        this.setStatus('idle');
        this.onChange();
        this.touch();
        this.hub.cliIdle();
        return;
      }
      case 'rate_limit_event':
        this.hub.rateLimit(m.rate_limit_info);
        return;
      case 'system':
        if (m.subtype === 'init') {
          if (this.resumeId) this.resumeId = m.session_id;
          if (learnTerminal(m.terminal_slash_commands) && this.slash) this.setCommands(this.slash);
          void this.refreshContext();
        }
        if (m.subtype === 'session_state_changed') this.setStatus(m.state === 'idle' ? 'idle' : 'working');
        if (m.subtype === 'status') {
          this.compacting = m.status === 'compacting';
          if (m.compact_result === 'failed') {
            this.compactions++;
            this.compactError = m.compact_error ?? 'The summary could not be made';
          }
          if (this.compacting) this.compactError = null;
          this.mapChanged();
        }
        if (m.subtype === 'compact_boundary') {
          const c = m.compact_metadata;
          const ours = this.handoff?.phase === 'compacting';
          this.compacting = false;
          this.compactError = null;
          this.compactions++;
          this.lastCompact = { pre: c.pre_tokens, post: c.post_tokens ?? null, trigger: ours ? 'handoff' : c.trigger };
          if (ours && this.handoff) {
            this.compactedNow = true;
            this.handoff = { ...this.handoff, pre: c.pre_tokens, post: c.post_tokens ?? null };
          }
          this.mapChanged();
          void this.refreshContext();
        }
        // Mods' $.ui.toast; the SDK types do not list this subtype.
        const raw = m as unknown as { subtype?: string; text?: string; timeout_ms?: number; state?: string; detail?: string; failure_kind?: string };
        if (raw.subtype === 'ui_toast' && raw.text) this.toast(raw.text, raw.timeout_ms ?? TOAST_MS);
        if (raw.subtype === 'bridge_state') this.onBridgeState(raw.state, raw.detail, raw.failure_kind);
        if (raw.subtype === 'ui_invalidate') this.surface?.invalidate();
        if (m.subtype === 'commands_changed') this.setCommands(m.commands);
        return;
    }
  }
}
