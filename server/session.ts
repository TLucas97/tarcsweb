import { createHash, randomUUID, type UUID } from 'node:crypto';
import { unwatchFile, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { query, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition, CanUseTool, HookCallback, McpServerConfig, ModelUsage, Options, PermissionResult, Query, SDKMessage, SDKRateLimitInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment, ContextUsage, DockState, Effort, ExplainEvent, HandoffPhase, HandoffState, HeadsUp, LimitKey, Limits, Mode, Panel, ReplayInfo, SeqEvent,
  ServerEvent, SessionMap, SessionSummary, Settings, Status, Toast, Upload, AskReply, Question, McpPack, SlashItem, McpGroup, McpRow,
  McpAuthReply, McpPhase, ServerMessage, TimedEvent, WatchPage, WatchSub, RoundPick, ReplyStyle, StretchSeen, RemoteState, FindHit, Provider, Wake, TextLink, BrowserTool,
} from './protocol.ts';
import { cleanLinks, linkedSegs, type Seg } from './links.ts';
import { PROVIDER_CAPS, claudeEffort, providerOf } from './protocol.ts';
import { CodexMain, type MainHost } from './codex/main.ts';
import { codexAccount } from './codex/account.ts';
import { ColdLog, FIND_MAX, hitOf, mergeHits, trimPoint } from './coldLog.ts';
import { PHONE_NOTE, bridgeState, phoneMessage, remoteUrl, type PhoneMessage, type RemoteControl } from './remote.ts';
import { fullText } from './stretch.ts';
import { WatchTimeline, transcriptPath } from './watch.ts';
import { WAKE_MAX, earlierMessages, historyOf } from './history.ts';
import {
  BROWSER_TOOLS, MODS, PANEL_PACKS, PANEL_SERVERS, browserToolOf, isPanelPack, modDir, catalog, defaultOn, groupOf, mcpPacks, packOf, rememberSeen, saveChoices, saveMcp, savedChoices, savedMcp, seenServers, serversFor, type Catalog,
} from './mcp.ts';
import { browser } from './browser.ts';
import { HANDOFF_PREFIX, SWITCH_PREFIX, agentNote, noteLabel, type UiNode, type UiPromptAnswer, type UiPromptOp } from './protocol.ts';
import { PluginSurface, type UiAsk } from './surface.ts';
import { AgentTracker } from './agents.ts';
import type { LogProbe } from './procLog.ts';
import { ClaudeAgents } from './claudeAgents.ts';
import { PromptQueue } from './promptQueue.ts';
import { ChangeLog } from './changes.ts';
import { ActiveSkills } from './activeSkills.ts';
import { CodexAgents, type CodexAsk } from './codex/agents.ts';
import { generateImages } from './codex/images.ts';
import type { ApprovalDecision } from './codex/threads.ts';
import {
  APP_TOOLS, BROWSER_RECORD, CODEX_TOOLS, EDIT_TOOLS, PLUMBING, STREAMED, ToolLog, describeTool, diffDetail, parsePartial, planOf, roundKey, summarizeFor, toolName, toolName as displayTool,
} from './tools.ts';
import { APP_TOOL_NAMES, appServer, type Brokers, type ChoiceBroker, type ClaudeBroker, type CodexBroker, type RoundBroker } from './appTools.ts';
import { grantTools, type ToolGrant } from './mcpHost.ts';
import { modServer } from './modTools.ts';
import { BROWSER_AGENT_DESCRIPTION, STRETCH_GUIDE, VISUAL_PROMPT, VISUAL_REMINDER, browserAgentPrompt, browserPrompt, codexPrompt, codexReminder, stretchNote, type BrowserLayers } from './prompt.ts';
import { dataUrlImage, imageUrl, loadReplay, readReplayText, revokeAll } from './files.ts';
import { displayPath, oneLine, wakeOfNote, wakeOfSummary } from './text.ts';
import { Chapters, type TitleJob } from './chapters.ts';
import type { Titles } from './titles.ts';
import type { Voice } from './voice.ts';
import type { Phone } from './phone.ts';
import { explainError, resultText, tldr } from './notes.ts';
import { CommandCache, learnTerminal, localOutput, menuOf } from './commands.ts';
import { answerLight, explain, type ExplainRequest, type Fork } from './explain.ts';
import { config, handoffAt, t } from './config.ts';
import { connect } from './connect.ts';
import { onPerfChange, tuning } from './profile.ts';
import { slowWindowsFolder } from './machine.ts';
import { FOREVER } from './dismissals.ts';

// Handoff runs well before the SDK's auto-compact, so it only counts below the model's window.
const handoffBelow = (max: number) => {
  const at = handoffAt();
  return at !== null && at < max ? at : null;
};

// context-handoff never compacts under the SDK, so the app runs the handoff itself (see runHandoff).
// The mods ship in the repo; tarcsweb carries the bundled skills (grilling, learn-app, validate-pr) and no tools.
const WEB_MODS = [...MODS, 'tarcsweb'].map(modDir).join(':');

const PROGRESS_TOOL = 'mcp__agents-panel__progress';
const BROWSER_AGENT = 'browser';
const agentKey = (a: Record<string, AgentDefinition> | null) => (a ? `${a[BROWSER_AGENT].model}:${a[BROWSER_AGENT].tools?.join()}` : '');
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
const HANDOFF_GO_ON = 'This message was sent automatically. The task was still in progress: continue it from where it stopped, without asking the user first.';
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
export type HandoffDoc = { path: string; text: string };

async function saveHandoff(id: string, text: string): Promise<HandoffDoc> {
  await mkdir(HANDOFF_DIR, { recursive: true });
  const path = `${HANDOFF_DIR}/handoff-${id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  await writeFile(path, text);
  return { path, text };
}
export type Held = { text: string; pastes: string[]; files: Upload[]; thumbs: (string | null)[]; cid?: string; links?: TextLink[] };

type ContentBlockParam = Exclude<SDKUserMessage['message']['content'], string>[number];

function fileBlock(f: Upload): ContentBlockParam {
  if (f.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: f.mime as 'image/png', data: f.data } };
  if (f.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name };
  return { type: 'text', text: `File ${f.name}:\n\n${f.data}` };
}

// Claude in Chrome, offered in the MCP menu but started with the CLI's --chrome flag (no extra process).
const CHROME = 'claude-in-chrome';
const CHROME_TOOL = `mcp__${CHROME}__`;
// Packs in ~/.claude/mcp that drive a Chrome other than the panel's; the browser prompt steers away from them.
const OTHER_BROWSER_PACKS = ['chrome', 'playwright'];
// How long a Claude in Chrome call waits for the panel's extension to reach the bridge.
const CHROME_CONNECT_MS = 25_000;
// The whole browser check of one call, under the hook's 90 s timeout: a hook that times out lets the call through.
const BROWSER_CHECK_MS = 75_000;
// Claude in Chrome tools that only list or pick browsers; the model calls them itself when the user asks.
const CHROME_PICKS = ['list_connected_browsers', 'select_browser', 'switch_browser'];
const CHROME_ON_PANEL = "Checked by the app: Claude in Chrome's selected browser is the Browser panel's Chrome, so its calls act on the panel, not the user's own Chrome.";
const CHROME_RESET = "The Browser panel's Chrome or this session's Claude restarted while Claude in Chrome was checked. Try again.";
const CHROME_ELSEWHERE = (id: string) =>
  `Claude in Chrome is pointed at another browser, not the Browser panel. Ask the user, then use select_browser with deviceId ${id} to use the Browser panel.`;
const CHROME_UNSET = (id: string) =>
  `Claude in Chrome has no browser selected for this session. Ask the user, then use select_browser with deviceId ${id} to use the Browser panel.`;
const BROWSER_OFF = 'The Browser panel is off for agents. Ask the user to turn on "Use the Browser panel for agents" in the Browser panel.';
const PANEL_NEEDS = 'Turn on "Use the Browser panel for agents" in the Browser panel';
// inUse marks the browser this CLI's calls go to, once that is settled.
type ChromeBrowser = { deviceId: string; inUse?: boolean };
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
let codexPromptOf = codexPrompt;
let codexReminderOf = codexReminder;
let browserPromptOf = browserPrompt;
let browserAgentPromptOf = browserAgentPrompt;
let browserAgentDescription = BROWSER_AGENT_DESCRIPTION;
const promptUrl = new URL('./prompt.ts', import.meta.url);
const refreshPrompt = () => {
  import(`${promptUrl.href}?t=${Date.now()}`).then((m: typeof import('./prompt.ts')) => {
    visualPrompt = m.VISUAL_PROMPT;
    browserPromptOf = m.browserPrompt;
    browserAgentPromptOf = m.browserAgentPrompt;
    browserAgentDescription = m.BROWSER_AGENT_DESCRIPTION;
    visualReminder = m.VISUAL_REMINDER;
    stretchGuide = m.STRETCH_GUIDE;
    noteOf = m.stretchNote;
    codexPromptOf = m.codexPrompt;
    codexReminderOf = m.codexReminder;
  }, () => {});
};
const watchPrompt = () => {
  if (tuning().promptWatch) watchFile(fileURLToPath(promptUrl), { interval: 1500 }, refreshPrompt).unref();
  else unwatchFile(fileURLToPath(promptUrl), refreshPrompt);
};
watchPrompt();
onPerfChange((profile, prev) => { if (profile !== prev) watchPrompt(); });
const LAZY_TITLES = 10;
const CTX_WARN = 60;
// A window's reset time to the minute, so a second of jitter in the CLI's report keeps the same id.
const minute = (ms: number | null) => (ms ? Math.round(ms / 60_000) : 0);
const LIMIT_WARN = 80;
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

// Codex results waiting out a handoff before they reach the main agent.
const CODEX_HELD_MAX = 20;
// A notification this close to a turn's end may have missed it and woken the next turn instead.
const WAKE_LATE_MS = 3000;
// Enough recent messages for a cheap explanation to know what the excerpt refers to.
const RECENT_CHARS = 12_000;

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
  // A saved Codex thread this tab resumes, and the events before the seeded ones, loaded on request.
  codexThreadId?: string;
  earlier?: () => Promise<TimedEvent[]>;
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
// Forks that must never wait on the user or start agents.
const NO_CODEX = async (): Promise<never> => {
  throw new Error('Codex tools are not available here.');
};
const NO_ASK: Brokers = { choose: async () => null, round: async () => null, codex: { start: NO_CODEX, message: NO_CODEX, stop: NO_CODEX, image: NO_CODEX } };

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
  // Older events move to disk at the profile's cap, cut near a prompt so turns stay whole.
  private log: SeqEvent[] = [];
  private cold: ColdLog | null = null;
  // The newest prompt that went to disk, so recentText still has it when a long turn outgrows the log.
  private spilledPrompt: SeqEvent | null = null;
  // Events before the resumed ones (a transcript's segments before its last compaction, a Codex thread's older turns):
  // seqs up to 0, read on the first page or search that needs them.
  private earlier: (() => Promise<TimedEvent[]>) | null = null;
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
  private queuedMsgs = new Map<string, { text: string; pastes: string[]; files: Upload[]; thumbs: (string | null)[]; links: TextLink[] }>();
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
  // True from the main thread's first reply message until its result, so release() never cuts a turn short.
  private turnOpen = false;
  // A prompt from the user (typed, queued, phone, handoff) will open the next turn; without one, the turn is an update.
  private prompted = false;
  // Notifications that may wake the agent, capped at WAKE_MAX; ones that arrived well before the last turn end were read in it.
  private wakes: (Wake & { at: number })[] = [];
  private turnEndAt = 0;
  // Counts working spells, so the Browser panel opens itself once per turn at most.
  private turnNo = 0;
  // Reports pushed to the CLI by app agents, by prompt uuid, until the CLI picks them up (capped at WAKE_MAX).
  private reportWakes = new Map<string, Wake>();
  private tracker: AgentTracker;
  private changes: ChangeLog;
  private panelListeners = new Set<(json: string) => void>();
  private panelTimer: ReturnType<typeof setTimeout> | null = null;
  // What the panel's clients hold, as row JSON by id in order, so a tick sends only what changed.
  private sentAgents = new Map<string, string>();
  private sentProcs = new Map<string, string>();
  private sentActive = false;
  private codex: CodexAgents;
  // Claude subagents a Codex main started with claude_agent; their rows live in the tracker.
  private claude: ClaudeAgents;
  private codexHeld: string[] = [];
  // codex_agent calls seen in the stream, for a handler the CLI gave no tool_use id; capped at CODEX_HELD_MAX.
  private codexCalls: { id: string; key: string }[] = [];
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
  // Set once the cwd is found on a Windows drive under WSL.
  private slowFolder = false;
  private mapListeners = new Set<(json: string) => void>();
  private mapTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMap = '';
  private tools: ToolLog;
  private skills = new ActiveSkills();
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
  // started flips on the command's lifecycle 'started', so a result from a turn that ran before it is not taken for its own.
  private handoffWait: { uuid: string; started: boolean; resolve: () => void; reject: (err: Error) => void } | null = null;
  // The last TodoWrite or show_plan still had a step not done; a handoff then tells the agent to go on.
  private planOpen = false;
  private compactedNow = false;
  private held: Held[] = [];
  // Messages moved here by a provider switch; they go out when the seed turn ends.
  private afterSeed: Held[] = [];
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
  // The browser section the running CLI knows; a pack change mid-CLI rides on the next message as browserNote.
  private cliBrowser = '';
  private browserNote: string | null = null;
  // The browser subagent the running CLI registered, null for none; the SDK takes agents only at CLI start.
  private cliAgents: Record<string, AgentDefinition> | null = null;
  // Another browser this CLI verifiably selected through select_browser or switch_browser, next to the panel device
  // it was told apart from. Cleared before every new selection runs.
  private chromeOther: { q: Query; panel: string; device: string } | null = null;
  // The CLI already told that Claude in Chrome acts on the panel; its tool output never says which browser it drives.
  private chromeNoted: Query | null = null;
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
  // Follows the model until the first message, then stays.
  provider: Provider;
  private sent: boolean;
  private cx: CodexMain | null = null;
  private toolGrant: ToolGrant | null = null;

  private onChange: () => void;

  constructor(init: SessionInit, onChange: () => void, hub: Hub) {
    this.onChange = onChange;
    this.hub = hub;
    this.chapters = init.chapters ?? new Chapters();
    this.tools = init.tools ?? new ToolLog(init.cwd);
    this.createdHere = init.resumeId === null && !init.codexThreadId;
    this.id = init.id;
    this.cwd = init.cwd;
    this.name = init.name;
    this.branch = init.branch;
    this.mode = init.mode;
    this.model = init.model;
    this.effort = init.effort;
    this.provider = providerOf(init.model);
    this.sent = init.resumeId !== null;
    if (this.provider === 'claude') this.effort = claudeEffort(this.effort);
    this.resumeId = init.resumeId;
    if (init.earlier) this.earlier = init.earlier;
    else if (init.resumeId && init.firstUuid) {
      const { resumeId: tid, firstUuid: uuid, cwd } = init;
      this.earlier = async () => {
        const path = await transcriptPath(cwd, tid);
        return historyOf(path ? await earlierMessages(path, uuid) : [], cwd).events;
      };
    }
    this.named = init.resumeId !== null;
    this.persisted = init.resumeId !== null;
    // With the switch on, a new session starts with the panel packs; the MCP menu can still turn them off.
    this.mcp = init.resumeId === null && browser.agents && !savedMcp(init.id).length ? [PANEL_PACKS.playwright, PANEL_PACKS.devtools] : savedMcp(init.id);
    this.mcpChoices = savedChoices(init.id);
    void this.loadCatalog();
    void slowWindowsFolder(this.cwd).then((slow) => {
      if (!slow) return;
      this.slowFolder = true;
      this.mapChanged();
    });
    this.beforePlan = init.mode === 'plan' ? 'default' : init.mode;
    this.tracker = new AgentTracker(this.cwd, {
      model: () => this.model, effort: () => this.effort, changed: () => this.panelChanged(),
      edited: (path, add, rm) => this.chapters.edited(path, add, rm), read: (path) => this.chapters.read(path),
    });
    this.changes = new ChangeLog(this.cwd, (card) => this.push({ type: 'changes', ...card }), (owner) => this.tracker.nameOf(owner) ?? 'Agent');
    this.codex = new CodexAgents({
      cwd: this.cwd, mode: () => this.mode, changed: () => this.panelChanged(),
      edited: (owner, path, before, after, note, add, rm) => {
        this.changes.recordTexts({ id: owner, main: false }, path, before, after, note);
        this.chapters.edited(displayPath(this.cwd, path), add, rm);
      },
      ask: (a) => this.codexAsk(a),
      report: (text) => this.codexReport(text),
    });
    this.tracker.attach(this.codex);
    this.claude = new ClaudeAgents({
      cwd: this.cwd, mode: () => this.mode, tracker: this.tracker,
      ask: (row, name) => (toolName, input, opts) => this.askTool(toolName, input, opts, { row, name }),
      edited: (row, tool, input, response) => this.changes.record({ id: row, main: false }, tool, input, response),
      report: (text) => this.codexReport(text),
    });
    if (init.codexThreadId) {
      this.codexMain().threadId = init.codexThreadId;
      this.sent = true;
      this.named = true;
    }
  }

  map(): SessionMap {
    return {
      chapters: this.chapters.snapshot(), now: this.nowText(), need: this.asks.size > 0, headsUps: this.headsUps(),
      usage: { ctx: this.ctx, cost: this.cost, tokens: this.tokens, compacting: this.compacting },
      handoff: this.handoff, toasts: this.toasts.filter((t) => t.until > Date.now()), above: this.above,
      skills: this.skills.snapshot(this.slash ?? this.hub.commands.get(this.cwd)),
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
    }, tuning().mapMs);
  }

  dismiss(id: string) {
    if (id.startsWith('limit') || id.startsWith(FOREVER)) {
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

  // Titles and the last prompts and replies the skills suggestion reads; Codex tabs fill the same chapters.
  skillContext() {
    return this.chapters.recent(3);
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
    if (this.provider === 'codex') return this.codexMain().setName(name);
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
    if (this.slowFolder) {
      const id = `${FOREVER}${createHash('sha1').update(this.cwd).digest('hex').slice(0, 16)}`;
      add({ id, need: false, text: 'Slow folder: move it into your Linux home', detail: 'This project is on the Windows drive, where file access from WSL is slow. Moving it into your Linux home folder makes everything faster.', action: null });
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
    // Background work reports with a new turn; the turn end after it tries again. A dev server left running does not block it.
    if (this.pending.size || this.choices.length || this.tracker.agentsRunning()) return;
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
      const uuid = randomUUID();
      this.handoffWait = { uuid, started: false, resolve, reject };
      this.prompted = true;
      this.setStatus('working');
      capAdd(this.ownIds, uuid);
      this.ownPromptSent(text);
      this.ensureStarted().push({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null });
      this.used = true;
    });
  }

  // The card's "Try again" and the tab menu's "Hand off now": skips the tries cap and the gain guard. Returns why it can't.
  handoffNow(): string | null {
    if (this.provider === 'codex') return 'Codex compacts the conversation on its own';
    if (this.handingOff) return 'A handoff is already running';
    if (!this.resumeId) return 'Nothing to hand off yet; send a message first';
    if (this.status === 'working' || this.pending.size || this.choices.length) return 'Session is busy, try again when it finishes';
    void this.runHandoff(this.ctx?.used ?? null);
    return null;
  }

  // The card's close button: a live handoff stops and ends failed ("Stopped"); a finished card clears in every window.
  dismissHandoff() {
    if (!this.handoff) return;
    if (!this.handingOff) {
      this.handoff = null;
      this.mapChanged();
      return;
    }
    this.handoffAbort?.abort();
    const w = this.handoffWait;
    if (!w) return;
    this.handoffWait = null;
    w.reject(new Error('Stopped'));
    const q = this.q as (Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }) | null;
    // Still queued behind another turn: take it out of the queue instead of stopping that turn.
    if (!w.started) return void q?.cancelAsyncMessage?.(w.uuid).catch(() => false);
    this.stopRequested = true;
    void q?.interrupt().catch(() => {});
  }

  private async runHandoff(pre: number | null) {
    // Decided before the compaction, which drops what the agent was doing.
    const midTask = this.planOpen || this.tracker.agentsRunning();
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
      const lead = midTask ? 'Continue the work from it, together with the compaction summary above.' : 'Read it together with the compaction summary above; it is the context for the next message.';
      const text = [`${HANDOFF_PREFIX}${doc.path}.`, lead, '', doc.text, '', '---', midTask ? HANDOFF_GO_ON : HANDOFF_TAIL].join('\n');
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
      for (const h of held) this.send(h.text, h.pastes, h.files, h.thumbs, false, h.cid, undefined, h.links);
      this.flushCodexHeld();
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
    return saveHandoff(id, text);
  }

  // A provider switch, step one: this tab writes the handoff while messages sent to it are held.
  // The manager then opens the new tab and calls switched(), or switchFailed() when that fails.
  async prepareSwitch(to: Provider): Promise<HandoffDoc> {
    if (to === this.provider) throw new Error(`This tab already runs on ${to === 'codex' ? 'Codex' : 'Claude'}`);
    if (this.handingOff) throw new Error('A handoff is already running');
    if (this.status === 'working' || this.pending.size || this.choices.length) throw new Error('Session is busy, try again when it finishes');
    if (this.provider === 'claude' ? !this.persisted || !this.resumeId : !this.codexThreadId) throw new Error('Nothing to hand off yet; send a message first');
    const now = Date.now();
    this.handoff = {
      phase: 'writing', steps: { writing: now }, startedAt: now, endedAt: null, pre: this.ctx?.used ?? null, post: null, path: null, error: null, held: [], to, tab: null,
    };
    const abort = (this.handoffAbort = new AbortController());
    this.mapChanged();
    this.onChange();
    try {
      const doc = this.provider === 'claude' ? await this.writeHandoff(abort) : await this.writeCodexHandoff(abort.signal);
      if (abort.signal.aborted) throw new Error('Stopped');
      this.setHandoff({ path: doc.path }, 'handing');
      return doc;
    } catch (err) {
      this.switchFailed(err);
      throw err;
    }
  }

  private async writeCodexHandoff(signal: AbortSignal): Promise<HandoffDoc> {
    const prompt = `${HANDOFF_PROMPT}\n\nDo not call any tool or skill here. Answer with the handoff document itself, as plain text.`;
    const { text, ephemeral } = await this.codexMain().writeHandoff(prompt, signal);
    console.info(`[codex] handoff written by ${ephemeral ? 'an ephemeral fork' : 'a saved fork, now hidden and archived'}`);
    return saveHandoff(this.codexThreadId ?? this.id, text);
  }

  // The new tab is open; what was typed here meanwhile goes there, and this card points at it.
  switched(tab: string): Held[] {
    const held = this.held;
    this.held = [];
    this.handoffAbort = null;
    this.setHandoff({ tab }, 'done');
    this.flushCodexHeld();
    return held;
  }

  switchFailed(err: unknown) {
    if (!this.handoff || this.handoff.phase === 'failed') return;
    const aborted = this.handoffAbort?.signal.aborted;
    this.handoffAbort = null;
    this.setHandoff({ error: aborted ? 'Stopped' : err instanceof Error ? err.message : String(err) }, 'failed');
    const held = this.held;
    this.held = [];
    for (const h of held) this.send(h.text, h.pastes, h.files, h.thumbs, false, h.cid, undefined, h.links);
    this.flushCodexHeld();
  }

  private flushCodexHeld() {
    const notes = this.codexHeld;
    this.codexHeld = [];
    for (const n of notes) this.codexReport(n);
  }

  // A tab opened by a provider switch: its first turn reads the handoff; messages held meanwhile follow once that turn ends.
  seedSwitch(doc: HandoffDoc, from: Provider, name: string, held: Held[]) {
    this.named = true;
    // The first chapter is the handoff, so an automatic title would name the tab after it.
    this.userRenamed = true;
    this.autoName(name);
    const who = from === 'claude' ? 'Claude' : 'Codex';
    const text = [`${SWITCH_PREFIX}${doc.path}.`, `${who} held this conversation until now and wrote it for you. Continue the work from it.`, '', doc.text, '', '---', HANDOFF_TAIL].join('\n');
    this.afterSeed = held;
    this.send(text);
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
    }, tuning().panelMs);
  }

  // A Codex agent gets the text straight from here; a Claude subagent through the main thread's SendMessage.
  async messageAgent(agentId: string, text: string) {
    const row = this.tracker.snapshot().agents.find((a) => a.id === agentId && !a.main);
    if (!row) return this.toast('That agent is no longer in the panel');
    if (this.claude.has(agentId)) {
      try {
        this.claude.message(agentId, text);
        return this.toast(`Sent to ${row.name}`);
      } catch (e) {
        return this.toast(e instanceof Error ? e.message : String(e));
      }
    }
    if (row.kind === 'codex') {
      try {
        await this.codex.message(agentId, text);
        return this.toast(`Sent to ${row.name}`);
      } catch (e) {
        return this.toast(e instanceof Error ? e.message : String(e));
      }
    }
    if (!row.taskId) return this.toast(`${row.name} cannot take messages`);
    this.send(agentNote(row.name, row.taskId, text));
  }

  // The Codex tools of the app server; ids are the codex_agent call's tool_use id, which is also its panel row id.
  private codexBroker: CodexBroker = {
    start: async (args, toolUseId) => {
      const key = `${args.description}\n${args.prompt}`;
      const seen = toolUseId ? -1 : this.codexCalls.findIndex((c) => c.key === key);
      const id = toolUseId ?? (seen >= 0 ? this.codexCalls.splice(seen, 1)[0].id : `codex:${randomUUID()}`);
      const r = await this.codex.start(args, id);
      return `Codex agent started in the background. Agent id: ${id} (model ${r.model}${r.effort ? `, effort ${r.effort}` : ''}). It shows in the agents panel with its own progress. Its report arrives as a task-notification when it ends; do not poll or wait for it.`;
    },
    message: async (agentId, text) => {
      const how = await this.codex.message(agentId, text);
      return how === 'steered' ? 'Delivered to the running Codex agent.' : 'The Codex agent started a new turn with your message; its report arrives as a task-notification.';
    },
    stop: async (agentId) => {
      if (!this.codex.has(agentId) && !this.codex.byThread(agentId)) throw new Error(`No Codex agent with id ${agentId}.`);
      return (await this.codex.stop(agentId, 'agent')) ? 'Stopped the Codex agent.' : 'That Codex agent had already ended.';
    },
    image: (args, signal) => generateImages(args, this.cwd, signal),
  };

  // The Claude subagent tools of a Codex tab; the claude_agent call's id is also its panel row id.
  private claudeBroker: ClaudeBroker = {
    start: async (args, toolUseId) => {
      const id = toolUseId ?? `claude:${randomUUID()}`;
      const { model, effort } = await this.claude.start(args, id);
      return `Claude agent started in the background. Agent id: ${id} (${model}${effort ? `, effort ${effort}` : ''}). It shows in the agents panel with its own progress. Its report arrives as a task-notification when it ends; do not poll or wait for it.`;
    },
    message: async (agentId, text) => {
      const how = this.claude.message(agentId, text);
      return how === 'queued' ? 'Queued for the running Claude agent; it reads it after its current step.' : 'The Claude agent started a new turn with your message; its report arrives as a task-notification.';
    },
    stop: async (agentId) => {
      if (!this.claude.has(agentId)) throw new Error(`No running Claude agent with id ${agentId}.`);
      return (await this.claude.stop(agentId, 'agent')) ? 'Stopped the Claude agent.' : 'That Claude agent had already ended.';
    },
  };

  // A Codex approval as a permission card; it stays until answered, or until Codex or a stop settles it.
  private codexAsk(a: CodexAsk) {
    return new Promise<ApprovalDecision>((resolve) => {
      const id = `codex:${randomUUID()}`;
      const finish = (allow: boolean, reply?: AskReply, cancelled = false) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.asks.delete(id);
        a.signal.removeEventListener('abort', onAbort);
        this.waitEnded();
        this.mapChanged();
        this.push({ type: 'permission-resolved', id, allow, ...(reply ? { reply } : {}), ...(cancelled ? { cancelled: true as const } : {}) });
        this.onChange();
        this.touch();
        resolve(cancelled ? 'cancel' : !allow ? 'decline' : reply?.always ? 'acceptForSession' : 'accept');
      };
      const onAbort = () => finish(false, undefined, true);
      if (a.signal.aborted) return resolve('cancel');
      a.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, finish);
      this.waitStarted(WAIT.other);
      this.asks.set(id, { tool: a.tool, summary: a.summary });
      this.mapChanged();
      this.push({ type: 'permission', id, tool: a.tool, summary: a.summary, title: a.title, always: true, ...(a.detail ? { detail: a.detail } : {}) });
      this.onChange();
    });
  }

  // Wakes the main agent the way a finished background task does: a message in its queue, which starts a turn when idle.
  private codexReport(text: string) {
    if (this.handingOff) {
      this.codexHeld.push(text);
      if (this.codexHeld.length > CODEX_HELD_MAX) this.codexHeld.shift();
      return;
    }
    const uuid = randomUUID();
    const w = wakeOfNote(text);
    // Unseen in the chat, like on Claude: it steers the running turn or starts a new one.
    if (this.provider === 'codex') {
      if (!this.cx?.busy) this.push({ type: 'wake', id: `wake:${uuid}`, from: w ? [w] : [] });
      return this.codexSend(uuid, text, []);
    }
    if (w) {
      this.reportWakes.set(uuid, w);
      if (this.reportWakes.size > WAKE_MAX) this.reportWakes.delete(this.reportWakes.keys().next().value!);
    }
    capAdd(this.ownIds, uuid);
    this.ownPromptSent(text);
    this.ensureStarted().push({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.used = true;
    this.touch();
  }

  private deliver(id: string) {
    const w = this.reportWakes.get(id);
    if (w) {
      this.reportWakes.delete(id);
      // Picked up inside a running turn, it is part of that turn.
      if (!this.turnOpen) this.noteWake(w);
    }
    if (!this.queuedIds.delete(id)) return;
    // A queued prompt picked up between turns opens the next one.
    if (!this.turnOpen) this.prompted = true;
    this.queuedMsgs.delete(id);
    this.push({ type: 'delivered', id });
  }

  private codexMain() {
    return (this.cx ??= new CodexMain(this.codexHost()));
  }

  private codexSend(id: string, text: string, files: Upload[], segs?: Seg[] | null) {
    void this.codexMain().send(id, text, files, segs).catch((e: unknown) => this.notSent([id], `Codex could not take the message (${e instanceof Error ? e.message : String(e)}).`));
  }

  // Messages Codex will never get: their bubbles go, the error names them, and a tab with no turn running goes idle.
  private notSent(ids: string[], why: string) {
    const lost: string[] = [];
    for (const id of ids) {
      this.queuedIds.delete(id);
      this.queuedMsgs.delete(id);
      const e = this.recentUser(id);
      if (!e) continue;
      lost.push(`"${oneLine(e.text || e.files?.map((f) => f.name).join(', ') || 'Pasted text', 60)}"`);
      this.push({ type: 'unqueued', id });
    }
    this.push({ type: 'error', message: lost.length ? `${why} Not sent: ${lost.join(', ')}.` : why });
    if (this.status === 'working' && !this.cx?.busy) this.codexTurnEnd(false, 'error_during_execution', null, null, false);
  }

  // The tab's grant on the app's MCP endpoint; generate_image stays out, Codex makes images natively.
  // Built per MCP session, so the Claude tools follow the sign-in state at each thread start.
  private codexTools() {
    return (this.toolGrant ??= grantTools((name) => {
      if (name !== 'app') return modServer(name);
      const claude = connect.status?.loggedIn === false ? undefined : this.claudeBroker;
      return appServer({ choose: this.choose, round: this.askRound, codex: this.codexBroker, claude }, ['generate_image']).instance;
    }));
  }

  private dropCodex() {
    void this.cx?.close();
    this.cx = null;
    this.toolGrant?.revoke();
    this.toolGrant = null;
  }

  // The Codex driver's view of this session: everything it emits goes through the same log, panel, ChangeLog and chapters as Claude's.
  private codexHost(): MainHost {
    return {
      cwd: this.cwd,
      sessionId: this.id,
      model: () => this.model,
      effort: () => this.effort,
      mode: () => this.mode,
      push: (e) => this.push(e),
      text: (id, delta) => {
        this.lastTextId = id;
        this.appendText(id, delta);
        this.chapters.text(delta);
        this.setActivity('Writing a reply');
      },
      activity: (t) => this.setActivity(t),
      tool: (e) => {
        this.chapters.tool();
        this.push(e);
        this.touch();
      },
      delivered: (id) => this.deliver(id),
      notSent: (ids, why) => this.notSent(ids, why),
      // Also the turn a queued message starts right after the last one ended, while the tab never went idle.
      turnStarted: () => {
        this.tracker.statusChanged(true);
        if (this.status === 'working') return;
        this.stopRequested = false;
        this.setStatus('working');
      },
      turnEnded: (ok, subtype, text, ms, more) => this.codexTurnEnd(ok, subtype, text, ms, more),
      edited: (path, before, after, note, add, rm) => {
        this.changes.recordTexts({ id: 'main', main: true }, path, before, after, note);
        this.tracker.mainFile(path, add, rm);
      },
      plan: (task, steps) => this.tracker.mainPlan(task, steps),
      usage: (u) => {
        const used = u.last.totalTokens || u.total.totalTokens;
        const max = u.modelContextWindow;
        if (max) this.ctx = { pct: Math.round((used / max) * 100), used, max, compactAt: null, handoffAt: null };
        this.tokens = u.total.totalTokens;
        this.tracker.mainUsage(used, max);
        this.mapChanged();
      },
      compacting: (on) => {
        this.compacting = on;
        if (on) this.compactError = null;
        else {
          this.compactions++;
          this.lastCompact = { pre: this.ctx?.used ?? 0, post: null, trigger: 'auto' };
          this.skills.compacted();
        }
        this.mapChanged();
      },
      ask: async (a) => {
        const key = `codex-ask:${randomUUID()}`;
        this.tracker.permission(key, undefined, true);
        try {
          return await this.codexAsk(a);
        } finally {
          this.tracker.permission(key, undefined, false);
        }
      },
      failedCommand: (id, command, output) => {
        explainError(command, output, 'codex')
          .then((text) => text && this.push({ type: 'tool-note', id, text }))
          .catch((err) => console.error(`error note failed: ${err instanceof Error ? err.message : String(err)}`));
      },
      toolConfig: () => this.codexTools().config,
      ownTool: (id, name, input) => {
        if (!PLUMBING.has(name)) this.chapters.tool();
        if (name === CODEX_TOOLS.agent) {
          const o = (input ?? {}) as { description?: unknown; prompt?: unknown };
          this.codexCalls.push({ id, key: `${String(o.description ?? '')}\n${String(o.prompt ?? '')}` });
          if (this.codexCalls.length > CODEX_HELD_MAX) this.codexCalls.shift();
        }
        if (name === PROGRESS_TOOL) this.tracker.mainProgress((input ?? {}) as Record<string, unknown>);
        this.mainToolCall(id, name, input);
        this.touch();
      },
      ownResult: (id, content, isError) => {
        const ev = this.tools.result(id, content, isError);
        if (ev) this.push(ev);
      },
      instructions: () => {
        const base = codexPromptOf(config.language, connect.status?.loggedIn !== false);
        return this.style === 'stretch' ? `${base}\n\n${stretchGuide}` : base;
      },
      reminder: () => codexReminderOf(config.language),
      note: () => {
        const n = this.stretchNote;
        this.stretchNote = null;
        return n;
      },
    };
  }

  // Claude's result handling, for a Codex turn; with more queued, the next turn starts right away and the tab stays working.
  private codexTurnEnd(ok: boolean, subtype: string, text: { id: string; text: string } | null, ms: number | null, more: boolean) {
    // A question card can outlive its call when Codex drops the request without cancelling it.
    this.cancelChoices();
    this.tracker.turnEnd(ok, undefined);
    this.changes.flush();
    this.activity = '';
    const job = this.chapters.turnEnd(Date.now());
    if (job) this.requestTitle(job);
    this.push({ type: 'turn-end', ok: ok && !this.stopRequested, subtype });
    this.stopRequested = false;
    this.lastTextId = null;
    if (ok && text && this.style !== 'stretch') void this.summarize(text.id, text.text);
    if (more) return;
    if (ok) this.hub.phone.turnEnded(ms ?? 0, (t) => this.toast(t));
    if (!this.listeners.size) this.unseenDone = true;
    this.doneAt = Date.now();
    this.setStatus('idle');
    this.onChange();
    this.touch();
    this.hub.cliIdle();
  }

  async stopTask(taskId: string) {
    if (this.claude.has(taskId)) {
      await this.claude.stop(taskId, 'user');
      return;
    }
    const codexId = this.codex.byThread(taskId);
    if (codexId) {
      await this.codex.stop(codexId, 'user');
      return;
    }
    try {
      await this.q?.stopTask(taskId);
    } catch (err) {
      this.push({ type: 'error', message: `Stop failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // What a log watch reads for one background command: its live CLI tail, the SDK's output_file and the command text.
  logProbe(taskId: string): LogProbe | null {
    const proc = this.tracker.taskOf(taskId);
    if (!proc) return null;
    const q = this.q as WithTaskOutput | null;
    return {
      command: proc.command, cwd: this.cwd, ended: proc.state !== 'running', summary: proc.summary, outputFile: this.tracker.outputFile(taskId),
      live: async () => (q?.getTaskOutput ? q.getTaskOutput(taskId) : null),
    };
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
      provider: this.provider, caps: PROVIDER_CAPS[this.provider], fresh: !this.sent,
    };
  }

  // The Codex thread behind this tab, once it has one; the session list and resume key Codex tabs by it.
  get codexThreadId() {
    return this.cx?.threadId ?? null;
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
    // Kept as chosen but locked while the agents switch is off, so turning it on brings them back.
    if (!browser.agents) for (const r of rows) if (isPanelPack(r.key)) Object.assign(r, { locked: true, state: undefined, error: undefined, needs: PANEL_NEEDS });
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
    this.holdBrowser();
    this.syncBrowserNote();
    // Chrome is a CLI flag and a denied server cannot come back live: both need a fresh CLI, now or once the turn ends.
    if ((hadChrome !== this.mcp.includes(CHROME) || wasOff !== this.mcpOff().join('\n')) && this.q) {
      if (!this.busy()) return void (await this.restartCli());
      this.cliStale = true;
      this.mcpChanged();
    } else if (await this.restartForAgent()) return;
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
    this.holdBrowser();
  }

  // A running CLI learns a changed browser section with its next message.
  private syncBrowserNote() {
    if (!this.q) return;
    const text = browserPromptOf(this.browserLayers(), !!this.cliAgents);
    if (text !== this.cliBrowser) this.browserNote = text ? `The browser tools changed. Use this from now on:\n\n${text}` : 'The Browser section of your instructions no longer applies.';
    this.cliBrowser = text;
  }

  // The owner flipped the agents switch: the menu, the prompt note and a running CLI's panel packs follow.
  async syncBrowserAgents() {
    this.mcpChanged();
    this.holdBrowser();
    this.syncBrowserNote();
    if (await this.restartForAgent()) return;
    const q = this.q;
    if (!q || !this.appMcp || !this.mcp.some(isPanelPack)) return;
    try {
      await q.setMcpServers({ app: this.appMcp, ...serversFor(this.mcp) });
    } catch (err) {
      this.push({ type: 'error', message: `MCP change failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    await this.refreshMcp();
  }

  // The browser layers this session's running CLI has, so the panel keeps Chrome up and shows them.
  private holdBrowser() {
    const tools: BrowserTool[] = [];
    if (this.q) {
      if (this.cliChrome && !browser.claudeWhyNot) tools.push('claude');
      if (this.mcp.includes(PANEL_PACKS.playwright)) tools.push('playwright');
      if (this.mcp.includes(PANEL_PACKS.devtools)) tools.push('devtools');
    }
    browser.hold(this.id, tools);
  }

  private browserLayers(): BrowserLayers {
    if (!browser.agents) return { playwright: false, devtools: false, claude: false, other: [] };
    const other = mcpPacks().filter((p) => OTHER_BROWSER_PACKS.includes(p.key) && this.mcp.includes(p.key)).flatMap((p) => Object.keys(p.servers).map((s) => `mcp__${s}__`));
    const chrome = this.mcp.includes(CHROME);
    const own = !!browser.claudeWhyNot;
    return { playwright: this.mcp.includes(PANEL_PACKS.playwright), devtools: this.mcp.includes(PANEL_PACKS.devtools), claude: chrome && !own, claudeOwn: chrome && own, other };
  }

  // The browser subagent, when the switch and a panel layer are on. Server-level tool entries resolve when it spawns,
  // so panel packs switched live reach it without a restart; Claude in Chrome only when it acts on the panel.
  private browserAgent(): Record<string, AgentDefinition> | null {
    const l = this.browserLayers();
    if (!l.playwright && !l.devtools && !l.claude) return null;
    const servers = [PANEL_SERVERS.playwright, PANEL_SERVERS.devtools, ...(l.claude ? [CHROME] : [])].map((s) => `mcp__${s}`);
    const tools = [...servers, BROWSER_RECORD, PROGRESS_TOOL, 'Read', 'Grep', 'Glob', 'ToolSearch'];
    const prompt = browserAgentPromptOf(l.claude) + PROGRESS_NOTE;
    return { [BROWSER_AGENT]: { description: browserAgentDescription, prompt, tools, model: config.browserAgentModel } };
  }

  // Agents are fixed at CLI start, so a changed browser subagent needs a fresh CLI, now or once the turn ends.
  // Returns whether it restarted now.
  private async restartForAgent() {
    if (!this.q || agentKey(this.browserAgent()) === agentKey(this.cliAgents)) return false;
    if (!this.busy()) {
      await this.restartCli();
      return true;
    }
    this.cliStale = true;
    this.mcpChanged();
    return false;
  }

  // The panel learned it cannot (or now can) host Claude in Chrome here; the badges and the prompt note follow.
  syncBrowserSupport() {
    this.holdBrowser();
    this.syncBrowserNote();
    void this.restartForAgent();
  }

  // Lights the panel's badge. The panel packs connect on first use and Claude in Chrome needs the panel's extension on
  // the bridge, so Chrome must be up before the tool runs; a failure denies the call instead of using another browser.
  private browserHook: HookCallback = async (input, _id, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = browserToolOf(input.tool_name);
    if (!tool) return {};
    // Switch off, or a panel that cannot host it here: Claude in Chrome runs as in stock Claude Code; a panel pack left
    // loaded in this CLI has no browser.
    if (tool === 'claude' && browser.claudeWhyNot) return {};
    if (!browser.agents) {
      if (tool === 'claude') return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: BROWSER_OFF } };
    }
    const q = this.q;
    const until = Date.now() + BROWSER_CHECK_MS;
    // Held from here until the call ends (Post hooks, turn end or CLI stop), so Chrome cannot idle out under it.
    browser.acquire(this.id, input.tool_use_id, () => this.q === q && this.busy());
    let on: 'panel' | 'other' | 'pick' = 'panel';
    // A check still running near the hook's own timeout denies, since a timed-out hook lets the call through.
    let late: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, no) => (late = setTimeout(() => no(new Error('The browser check timed out. Try the call again.')), BROWSER_CHECK_MS + 5000)));
    try {
      if (tool !== 'claude') await Promise.race([browser.ensure(until), deadline]);
      else on = await Promise.race([this.chromeCheck(input.tool_name, until, signal), deadline]);
    } catch (err) {
      browser.release(this.id, input.tool_use_id);
      const why = err instanceof Error ? err.message : String(err);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
    } finally {
      clearTimeout(late);
    }
    if (on === 'other') browser.release(this.id, input.tool_use_id);
    if (on === 'panel') browser.activity(tool, this.id, this.turnNo);
    // Its list names browsers "Browser 1, 2…", so the model cannot tell which one is the panel without the id.
    if (on === 'pick' && input.tool_name === `${CHROME_TOOL}list_connected_browsers`) {
      const device = await browser.claudeDevice().catch(() => null);
      if (device) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `Checked by the app: the Browser panel's Chrome is the browser with deviceId ${device}.` } };
    }
    if (on === 'panel' && tool === 'claude' && this.chromeNoted !== q) {
      this.chromeNoted = q;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: CHROME_ON_PANEL } };
    }
    return {};
  };

  // A browser call ended (done, failed or refused), so Chrome may count down to idle again.
  private browserDoneHook: HookCallback = async (input) => {
    if ('tool_use_id' in input && typeof input.tool_use_id === 'string') browser.release(this.id, input.tool_use_id);
    return {};
  };

  // Lets a Claude in Chrome call through when it acts on the panel browser, or on another browser this CLI verifiably
  // selected. It never changes the selection itself; whatever it cannot confirm denies the call.
  private async chromeCheck(name: string, until: number, signal: AbortSignal): Promise<'panel' | 'other' | 'pick'> {
    const action = name.slice(CHROME_TOOL.length);
    const q = this.q;
    if (!q) throw new Error(CHROME_RESET);
    if (CHROME_PICKS.includes(action)) {
      // A new selection voids the old one before it runs; the panel starts so it shows up in the list.
      if (action !== 'list_connected_browsers') this.chromeOther = null;
      await browser.ensure(Math.min(until, Date.now() + 40_000)).catch(() => {});
      return 'pick';
    }
    try {
      await browser.ensure(Math.min(until, Date.now() + 40_000));
    } catch (err) {
      throw new Error(`The Browser panel's Chrome did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The start may have found that this machine's Chrome cannot host Claude in Chrome.
    if (browser.claudeWhyNot) return 'other';
    const run = browser.runId;
    const connectBy = Math.min(until, Date.now() + CHROME_CONNECT_MS);
    for (;;) {
      if (this.q !== q || browser.runId !== run) throw new Error(CHROME_RESET);
      const device = await browser.claudeDevice();
      let list: ChromeBrowser[] | null = null;
      let err: unknown = null;
      try {
        list = await this.chromeBrowsers(q, until, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        err = e;
      }
      if (this.q !== q || browser.runId !== run) throw new Error(CHROME_RESET);
      if (device && list) {
        const used = list.find((b) => b.inUse)?.deviceId;
        if (used === device) return 'panel';
        const other = this.chromeOther;
        if (used && other?.q === q && other.panel === device && other.device === used) return 'other';
        // With the panel's extension on the bridge the answer is settled: the user decides, nothing switches here.
        if (list.some((b) => b.deviceId === device)) throw new Error(used ? CHROME_ELSEWHERE(device) : CHROME_UNSET(device));
      }
      if (Date.now() + 1000 > connectBy) {
        if (!list) throw new Error(`Could not check which browser Claude in Chrome uses: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error(device
          ? "The Browser panel's Claude extension did not connect. Open the Browser panel and check that Claude in Chrome is signed in there."
          : 'Claude in Chrome is not set up in the Browser panel. Open the panel, install the Claude extension there and sign in.');
      }
      await new Promise<void>((ok) => {
        const done = () => {
          clearTimeout(t);
          signal.removeEventListener('abort', done);
          ok();
        };
        const t = setTimeout(done, 1000);
        signal.addEventListener('abort', done);
      });
      if (signal.aborted) throw new Error('The browser check was cancelled.');
    }
  }

  // Claude in Chrome's own tools, called on the control channel: no model turn, no permission prompt. A timeout or the
  // hook's abort cancels the request in the CLI too.
  private async chromeCall(q: Query, action: string, args: Record<string, unknown>, until: number, signal: AbortSignal) {
    type Request = (req: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<{ response?: unknown }>;
    const ctl = q as Query & { request?: Request };
    if (!ctl.request) throw new Error('This Claude Code version cannot check the Claude in Chrome browser.');
    const ms = Math.min(15_000, until - Date.now());
    if (ms <= 0) throw new Error('Claude in Chrome did not answer in time.');
    const late = AbortSignal.timeout(ms);
    let r: { response?: unknown };
    try {
      r = await ctl.request({ subtype: 'mcp_call', tool: `${CHROME_TOOL}${action}`, arguments: args }, { signal: AbortSignal.any([signal, late]) });
    } catch (err) {
      if (late.aborted && !signal.aborted) throw new Error('Claude in Chrome did not answer in time.');
      throw err;
    }
    const res = r.response as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
    const text = res?.content?.find((c) => c.type === 'text')?.text ?? '';
    if (res?.isError) throw new Error(`Claude in Chrome: ${oneLine(text, 200)}`);
    return text;
  }

  // Throws when the list cannot be read, so an error never passes for "no browser" or "another browser".
  private async chromeBrowsers(q: Query, until: number, signal: AbortSignal): Promise<ChromeBrowser[]> {
    const list = JSON.parse(await this.chromeCall(q, 'list_connected_browsers', {}, until, signal));
    if (!Array.isArray(list)) throw new Error('Claude in Chrome sent an unexpected browser list.');
    return list.filter((b) => typeof b?.deviceId === 'string');
  }

  // The model selected a browser (the user asked). It counts only when this CLI now verifiably uses a browser other than
  // the identified panel device; anything unclear leaves later calls checked against the panel.
  private chromePickHook: HookCallback = async (input, _id, { signal }) => {
    const q = this.q;
    if (input.hook_event_name !== 'PostToolUse' || !q) return {};
    this.chromeOther = null;
    try {
      const res = input.tool_response as { isError?: unknown } | null;
      if (res && typeof res === 'object' && res.isError) return {};
      const device = await browser.claudeDevice();
      if (!device) return {};
      const used = (await this.chromeBrowsers(q, Date.now() + 15_000, signal)).find((b) => b.inUse)?.deviceId;
      const asked = (input.tool_input as { deviceId?: unknown } | null)?.deviceId;
      if (this.q !== q || !used || used === device || (typeof asked === 'string' && asked !== used)) return {};
      this.chromeOther = { q, panel: device, device: used };
    } catch {}
    return {};
  };

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
    for (const e of events) {
      this.log.push({ ...e, seq: ++this.seq, sessionId: this.id } as SeqEvent);
      this.skills.note(e);
    }
    this.spill();
  }

  // Never takes the last entry, which streaming text still merges into.
  private spill() {
    if (this.log.length <= tuning().logMax) return;
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
    const more = !!this.cold?.size || !!this.earlier;
    return { events, replace, older: replace && more ? (this.log[0]?.seq ?? this.seq + 1) : null };
  }

  private prehistory() {
    const load = this.earlier;
    if (!load) return Promise.resolve(null);
    return (this.pre ??= (async () => {
      const events = await load();
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
      if (page?.found) return { events: page.events, older: page.older ?? (this.earlier ? cold.bottom : null) };
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
    // One shared app-server serves every Codex tab; loading the catalog boots it.
    if (this.provider === 'codex') return void codexAccount.models().catch(() => {});
    if (this.queue) this.armIdle();
    else this.ensureStarted();
  }

  // A live CLI that could be stopped without losing work. Remote Control needs it running.
  get idleCli() {
    // With no idle CLIs allowed (Lite), a CLI warmed for typing waits for its send; armIdle still stops it.
    return !!this.q && !this.busy() && !this.remoteWanted && (this.used || tuning().idleClis > 0);
  }

  // A Codex thread held in the shared app-server with no turn running; unloading it loses nothing.
  get idleThread() {
    return !!this.cx?.loaded && !this.busy();
  }

  // Returns why it could not turn on (the CLI's own reason), or null.
  async setRemoteControl(on: boolean): Promise<string | null> {
    if (on && this.provider === 'codex') return 'Remote Control works on Claude tabs only';
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
    return this.status === 'working' || this.turnOpen || this.handingOff || this.pending.size > 0 || this.choices.length > 0 || this.tracker.hasRunning();
  }

  // Pasted blocks travel with the prompt as plain text, ahead of what was typed; files go first as their own blocks.
  // cid is the client's id for the message: the echo carries it, and a retry of an already sent one is dropped.
  // links tie text spans to attachments; with any, the content interleaves them (server/links.ts).
  send(text: string, pastes: string[] = [], files: Upload[] = [], thumbs: (string | null)[] = [], now = false, cid?: string, seen?: StretchSeen, links: TextLink[] = []) {
    if (cid && this.echoed(cid)) return;
    if (this.handingOff && this.handoff) {
      if (cid && this.held.some((h) => h.cid === cid)) return;
      this.held.push({ text, pastes, files, thumbs, cid, links });
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
    links = cleanLinks(text, links, files.length + pastes.length);
    if (queued) {
      this.queuedIds.add(id);
      this.queuedMsgs.set(id, { text, pastes, files, thumbs, links });
    } else this.prompted = true;
    this.push({ type: 'user', id, text, ...(pastes.length ? { pastes } : {}), ...(shown.length ? { files: shown } : {}), ...(links.length ? { links } : {}), ...(queued ? { queued } : {}) });
    const typed = [...pastes, text].filter((t) => t.trim()).join('\n\n');
    const segs = linkedSegs(text, pastes, files, links);
    const content: string | ContentBlockParam[] = segs
      ? segs.map((s) => ('file' in s ? fileBlock(s.file) : { type: 'text' as const, text: s.text }))
      : files.length ? [...files.map(fileBlock), ...(typed ? [{ type: 'text' as const, text: typed }] : [])] : typed;
    const label = (noteLabel(text) ?? text) || (files.length ? files.map((f) => f.name).join(', ') : 'Pasted text');
    this.chapters.start(id, label, Date.now());
    this.changes.startTurn(id);
    this.activity = '';
    this.sent = true;
    if (this.provider === 'codex') this.codexSend(id, typed, files, segs);
    else {
      capAdd(this.ownIds, id);
      // How the hook joins several text blocks is not documented; an empty entry matches the next prompt.
      this.ownPromptSent(segs ? '' : typed);
      // The uuid comes back in command_lifecycle, which says when the CLI actually picks the message up.
      this.ensureStarted().push({ type: 'user', uuid: id, message: { role: 'user', content }, parent_tool_use_id: null, ...(now ? { priority: 'now' as const } : {}) });
      this.used = true;
      this.resumeId ??= this.id;
    }
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
    return !!this.recentUser(cid);
  }

  private recentUser(id: string) {
    for (let i = this.log.length - 1; i >= Math.max(0, this.log.length - 500); i--) {
      const e = this.log[i];
      if (e.type === 'user' && e.id === id) return e;
    }
    return null;
  }

  async rename(title: string) {
    this.name = title;
    this.named = true;
    this.userRenamed = true;
    this.onChange();
    if (this.provider === 'codex') this.codexMain().setName(title);
    else if (this.persisted) await renameSession(this.resumeId!, title);
    else this.pendingTitle = title;
  }

  answerPermission(id: string, allow: boolean, reply?: AskReply) {
    this.pending.get(id)?.(allow, reply);
  }

  async interrupt() {
    this.tracker.markInterrupted();
    this.stopRequested = true;
    // A plan the user stopped is not one a handoff should resume.
    this.planOpen = false;
    this.cancelChoices();
    this.handoffAbort?.abort();
    if (this.cx) return this.cx.interrupt();
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
    const provider = providerOf(model);
    if (provider !== this.provider) {
      // The roster goes out again, so the client's optimistic pick is undone.
      if (this.sent) {
        this.onChange();
        return this.toast(`This tab runs on ${this.provider === 'codex' ? 'Codex' : 'Claude'}. Start a new tab to use the other one.`);
      }
      // Switched before the await, so a send meanwhile goes to the new provider with its model.
      this.provider = provider;
      if (provider === 'codex') {
        this.model = model;
        this.effort = effort;
        await this.stopCli();
      } else this.dropCodex();
    }
    if (provider === 'codex') {
      // Codex reads model and effort on every turn/start.
      this.model = model;
      this.effort = effort;
      return this.onChange();
    }
    effort = claudeEffort(effort);
    const modelChanged = model !== this.model;
    const effortChanged = effort !== this.effort;
    this.model = model;
    this.effort = effort;
    this.onChange();
    if (modelChanged) await this.control(() => this.q?.setModel(model), 'Model');
    if (effortChanged) await this.control(() => this.q?.applyFlagSettings({ effortLevel: claudeEffort(effort) }), 'Effort');
  }

  // Resolves once the CLI process is gone.
  close() {
    this.codex.closeAll();
    this.claude.closeAll();
    // Interrupts the turn; the thread's pending approvals end as cancelled cards, and its MCP token stops working.
    this.dropCodex();
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
    this.turnOpen = false;
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
    const thread = !!this.cx?.loaded;
    this.idleTimer = this.q || thread ? setTimeout(() => this.release(), this.used || thread ? tuning().cliIdleMs : Math.min(WARM_MS, tuning().cliIdleMs)) : null;
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
    if (!this.q && !this.cx?.loaded) return;
    if (this.busy()) return this.touch();
    // A Codex thread resumes by id on the next send.
    if (this.cx?.loaded) this.cx.unload();
    if (!this.q) return;
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
      if (this.skills.note(e)) this.mapChanged();
    }
    for (const fn of this.listeners) fn(ev);
  }

  // A turn the CLI starts itself (a background agent's notification) sends no state change, so its reply marks it working.
  private openTurn() {
    if (this.handoff?.phase === 'compacting') return;
    if (!this.turnOpen) this.turnBegan();
    this.turnOpen = true;
    if (this.status === 'idle') this.setStatus('working');
  }

  // A turn no prompt opened gets an update header naming what woke the agent.
  private turnBegan() {
    const self = !this.prompted;
    const from = this.wakes.filter((w) => w.at >= this.turnEndAt - WAKE_LATE_MS).map(({ via, name }) => ({ via, name }));
    this.prompted = false;
    this.wakes = [];
    if (self) this.push({ type: 'wake', id: `wake:${randomUUID()}`, from });
  }

  private noteWake(w: Wake | null) {
    if (!w) return;
    this.wakes = [...this.wakes.filter((x) => x.name !== w.name || x.via !== w.via), { ...w, at: Date.now() }].slice(-WAKE_MAX);
  }

  private setStatus(state: Status) {
    if (state === this.status) return;
    this.status = state;
    if (state === 'working') this.turnNo++;
    // A turn that ended runs no tool call, unless a background agent still does.
    else if (!this.tracker.hasRunning()) browser.releaseAll(this.id);
    this.mapChanged();
    this.surface?.invalidate();
    this.push({ type: 'status', state });
    this.tracker.statusChanged(state === 'working');
    this.onChange();
    this.panelChanged();
    if (state === 'idle' && this.afterSeed.length) {
      const held = this.afterSeed;
      this.afterSeed = [];
      queueMicrotask(() => {
        for (const h of held) this.send(h.text, h.pastes, h.files, h.thumbs, false, h.cid, undefined, h.links);
      });
    }
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
    this.flushTimer ??= setTimeout(() => this.flushText(), tuning().flushMs);
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

  // A main agent's tool call, from Claude's tool_use or a Codex item on one of our MCP servers.
  private mainToolCall(id: string, name: string, input: unknown) {
    const ev = this.tools.call(id, name, input);
    if (ev) this.push(ev);
    if (name === APP_TOOLS.choice) this.choiceSeen(id, name, String((input as { question?: unknown })?.question ?? ''));
    if (name === APP_TOOLS.round) this.choiceSeen(id, name, roundKey(input));
    if (name === 'Bash') this.bashCalls.set(id, String((input as { command?: unknown })?.command ?? ''));
    if (name === 'TodoWrite' || name === APP_TOOLS.plan) this.planOpen = !!planOf(name, input)?.steps.some((s) => s.status !== 'done');
    if (!PLUMBING.has(name)) this.setActivity(describeTool(this.cwd, name, input));
  }

  private choiceSeen(id: string, tool: string, question: string) {
    // A Codex call can reach the handler, with its id, before its item event.
    if (this.choices.some((c) => c.id === id)) return;
    const w = this.choices.find((c) => c.id === null && c.tool === tool && c.question === question);
    if (w) this.claim(w, id);
    else this.unclaimed.push({ id, tool, question });
  }

  // cancelAsyncMessage is not in the SDK types yet; when it fails, the message simply stays queued.
  async unqueue(id: string, then: 'remove' | 'now') {
    const msg = this.queuedMsgs.get(id);
    if (this.cx) {
      if (!msg) return;
      if (!this.cx.unqueue(id)) return this.toast('Codex already has that message');
      this.queuedIds.delete(id);
      this.queuedMsgs.delete(id);
      this.push({ type: 'unqueued', id });
      if (then === 'now') this.send(msg.text, msg.pastes, msg.files, msg.thumbs, true, undefined, undefined, msg.links);
      return;
    }
    const q = this.q as (Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }) | null;
    if (!msg || !q?.cancelAsyncMessage) return;
    const ok = await q.cancelAsyncMessage(id).catch(() => false);
    if (!ok) return this.toast('Claude already read that message');
    this.queuedIds.delete(id);
    this.queuedMsgs.delete(id);
    this.push({ type: 'unqueued', id });
    if (then === 'now') this.send(msg.text, msg.pastes, msg.files, msg.thumbs, true, undefined, undefined, msg.links);
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
      const r = await tldr(fullText(answer), this.provider);
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
    explainError(command, output, this.provider)
      .then((text) => text && this.push({ type: 'tool-note', id, text }))
      .catch((err) => console.error(`error note failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // explica mod: a throwaway fork of the transcript answers one side question, with tools denied.
  async explain(req: ExplainRequest, deep: boolean, reply: (e: ExplainEvent) => void) {
    const abort = new AbortController();
    this.forks.add(abort);
    try {
      const answer: Fork = deep && this.provider === 'claude' ? (prompt, a) => this.forkAnswer(prompt, a) : (prompt, a) => answerLight(this.recentText(), prompt, a);
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
    const notes = [visualReminder, this.browserNote, this.stretchNote].filter(Boolean);
    this.stretchNote = this.browserNote = null;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notes.join('\n\n') } };
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

  // Running subagents' new calls for watch mode, read from their transcripts; empty until a watch-load built the timeline.
  async watchSubs(since: [string, number][]): Promise<WatchSub[]> {
    const tid = this.transcriptId;
    if (!tid || this.watch?.id !== tid) return [];
    return this.watch.subsSince(since).catch(() => []);
  }

  private canUseTool: CanUseTool = (toolName, input, opts) => this.askTool(toolName, input, opts, null);

  // sub: a claude_agent run asking; its card names it and its row shows the wait.
  private askTool(
    toolName: string, input: Record<string, unknown>, { signal, title: asked, defaultToNo, toolUseID, agentID }: Parameters<CanUseTool>[2], sub: { row: string; name: string } | null,
  ) {
    const title = sub ? `Claude · ${sub.name}${asked ? ` — ${asked}` : ''}` : asked;
    return new Promise<PermissionResult>((resolve) => {
      const id = toolUseID || randomUUID();
      const finish = (allow: boolean, reply?: AskReply, elsewhere = false) => {
        this.pending.delete(id);
        this.asks.delete(id);
        // An allowed command keeps its "Running …" line; an answered question does not.
        if (!sub && (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode')) this.activity = '';
        if (!allow && !elsewhere) this.denied.add(id);
        this.waitEnded();
        this.mapChanged();
        this.tracker.permission(id, agentID, false, sub?.row);
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
      this.tracker.permission(id, agentID, true, sub?.row);
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
  }

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
    // The live CLI's browser section, so a handoff fork keeps the same prompt prefix.
    const append = [visualPrompt, this.cliBrowser, this.style === 'stretch' ? stretchGuide : ''].filter(Boolean).join('\n\n');
    return {
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      // A fresh server per process: an MCP server instance connects to one transport only.
      mcpServers: { app: appServer(brokers) },
      // Part of the Agent tool's description, so forks keep the live CLI's list too.
      ...(this.cliAgents ? { agents: this.cliAgents } : {}),
      cwd: this.cwd,
      model: this.model,
      effort: claudeEffort(this.effort),
      ...(process.env.CW_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CW_CLAUDE_BIN } : {}),
      // Only the mods whose tools this app renders; a flag layer beats the user settings' env. TARCSWEB tells skills they render in a browser; CLAUDE_WEB is its old name.
      // deniedMcpServers merges from every layer, so it switches settings-loaded servers off for this process only.
      // The same layer sets Claude Code's built-in You should know mod from Settings, over the user's own choice.
      // EMIT_SESSION_STATE_EVENTS lets session_state_changed reach us (the SDK eats it otherwise), so turns the CLI starts itself show as working.
      extraArgs: {
        settings: JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: WEB_MODS, TARCSWEB: '1', CLAUDE_WEB: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }, enabledPlugins: { 'cc-plugin-you-should-know@builtin': tuning().youShouldKnow && config.youShouldKnow }, ...(off.length ? { deniedMcpServers: off.map((serverName) => ({ serverName })) } : {}) }),
        ...(this.mcp.includes(CHROME) ? { chrome: null } : {}),
      },
    };
  }

  private ensureStarted() {
    if (this.queue) return this.queue;
    const queue = new PromptQueue();
    this.cliAgents = this.browserAgent();
    this.cliBrowser = browserPromptOf(this.browserLayers(), !!this.cliAgents);
    this.browserNote = null;
    const base = this.baseOptions({ choose: this.choose, round: this.askRound, codex: this.codexBroker });
    this.appMcp = base.mcpServers!.app;
    this.cliOff = new Set(this.mcpOff());
    this.cliChrome = this.mcp.includes(CHROME);
    this.chromeOther = null;
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
        // The browser check keeps its own deadline (BROWSER_CHECK_MS) well inside this timeout.
        PreToolUse: [{ matcher: '^(Agent|Task)$', hooks: [this.agentHook] }, { matcher: BROWSER_TOOLS, hooks: [this.browserHook], timeout: 90 }],
        PostToolUse: [
          { matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [this.fileHook] },
          { matcher: BROWSER_TOOLS, hooks: [this.browserDoneHook] },
          { matcher: `^${CHROME_TOOL}(select|switch)_browser$`, hooks: [this.chromePickHook], timeout: 20 },
        ],
        PostToolUseFailure: [{ matcher: BROWSER_TOOLS, hooks: [this.browserDoneHook] }],
        PermissionDenied: [{ matcher: BROWSER_TOOLS, hooks: [this.browserDoneHook] }],
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
    this.holdBrowser();
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
        this.turnOpen = false;
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
    // Default packs a new session started with stay on once it exists, so a restart resumes it the same way.
    if (this.mcp.length && !savedMcp(this.id).length) saveMcp(this.id, this.mcp);
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
    this.prompted = true;
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
      if (life.state !== 'queued' && life.command_uuid) this.deliver(life.command_uuid);
      const w = this.handoffWait;
      if (w && life.command_uuid === w.uuid) {
        if (life.state === 'started') {
          w.started = true;
          // A background turn's result may have set idle while this command waited in the queue.
          this.setStatus('working');
        } else if (life.state === 'cancelled' || life.state === 'discarded' || life.state === 'refused') {
          this.handoffWait = null;
          w.reject(new Error(life.state === 'cancelled' ? 'The handoff was stopped' : 'Claude Code did not take the handoff'));
        }
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
          this.openTurn();
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
          }, tuning().partialMs);
        } else if (ev.type === 'content_block_stop') {
          const st = this.streaming.get(ev.index);
          if (st?.timer) clearTimeout(st.timer);
          this.streaming.delete(ev.index);
        }
        return;
      }
      case 'assistant': {
        this.touch();
        for (const block of m.message.content) {
          if (block.type !== 'tool_use') continue;
          if (!PLUMBING.has(block.name)) this.chapters.tool();
          if (block.name === CODEX_TOOLS.agent) {
            const input = (block.input ?? {}) as { description?: unknown; prompt?: unknown };
            this.codexCalls.push({ id: block.id, key: `${String(input.description ?? '')}\n${String(input.prompt ?? '')}` });
            if (this.codexCalls.length > CODEX_HELD_MAX) this.codexCalls.shift();
          }
        }
        if (m.parent_tool_use_id) return;
        if (m.message.model !== '<synthetic>') this.openTurn();
        // The CLI's own text says to run /login, which this app has no use for; a fresh check shows the sign-in gate instead.
        const signedOut = m.error === 'authentication_failed';
        if (signedOut) {
          void connect.recheck();
          this.push({ type: 'error', message: 'Claude is signed out or its sign-in expired. Sign in again from Settings › Account.' });
        } else if (m.error) this.push({ type: 'error', message: `Assistant error: ${m.error}` });
        const msg = m.message;
        for (const block of msg.content) {
          if (signedOut && block.type === 'text') continue;
          if (block.type === 'tool_use') {
            this.dropPartials(block.id);
            this.mainToolCall(block.id, block.name, block.input);
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
        // Only the result of the turn the handoff pushed answers its wait; a background turn's result goes the normal way.
        const ours = !!this.handoffWait?.started;
        // The /compact command's own result is not a turn of the conversation.
        if (this.handoff?.phase === 'compacting' && this.handoffWait && ours) {
          this.turnOpen = false;
          this.usage(m.total_cost_usd, m.modelUsage, m.subtype === 'success');
          const w = this.handoffWait;
          this.handoffWait = null;
          if (this.compactedNow) w.resolve();
          else w.reject(new Error(this.compactError ?? (m.subtype === 'success' ? 'The compaction did not run' : 'The compaction was stopped')));
          return;
        }
        this.stopStreaming();
        this.turnOpen = false;
        this.prompted = false;
        this.turnEndAt = Date.now();
        this.tracker.turnEnd(m.subtype === 'success', m.modelUsage);
        this.changes.flush();
        this.usage(m.total_cost_usd, m.modelUsage, m.subtype === 'success');
        this.activity = '';
        const job = this.chapters.turnEnd(Date.now());
        if (job) this.requestTitle(job);
        const queued = this.sentBusy;
        this.sentBusy = false;
        void this.refreshContext().then(() => this.maybeHandoff(queued));
        if (this.handoff?.phase === 'handing' && this.handoffWait && ours) {
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
        if (m.subtype === 'task_notification') this.noteWake(this.tracker.wakeOf(m.task_id) ?? wakeOfSummary(m.summary ?? ''));
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
          this.skills.compacted();
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
