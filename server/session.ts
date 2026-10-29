import { randomUUID, type UUID } from 'node:crypto';
import { query, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition, HookCallback, McpServerConfig, ModelUsage, Options, Query, SDKMessage, SDKRateLimitInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment, ContextUsage, DockState, Effort, ExplainEvent, Limits, Mode, Panel, ReplayInfo, SeqEvent,
  ServerEvent, SessionMap, SessionSummary, Settings, Status, Upload, AskReply, SlashItem,
  McpAuthReply, TimedEvent, WatchPage, WatchSub, ReplyStyle, StretchSeen, FindHit, Provider, Wake, TextLink, BrowserChoice,
} from './protocol.ts';
import { cleanLinks, linkedSegs, type Seg } from './links.ts';
import { PROVIDER_CAPS, claudeEffort, providerOf } from './protocol.ts';
import { CodexMain, OUTPUT_MAX, type MainHost } from './codex/main.ts';
import { codexAccount } from './codex/account.ts';
import { PHONE_NOTE, type PhoneMessage } from './remote.ts';
import { WatchTimeline, transcriptPath } from './watch.ts';
import { WAKE_MAX, earlierMessages, historyOf } from './history.ts';
import { BROWSER_TOOLS, MODS, PANEL_PACKS, browserToolOf, modDir, saveMcp, savedMcp, serversFor } from './mcp.ts';
import { browser } from './browser.ts';
import { agentNote, noteLabel, type PeerAsk, type UiNode, type UiPromptAnswer } from './protocol.ts';
import { PluginSurface } from './surface.ts';
import { AgentTracker } from './agents.ts';
import type { LogProbe } from './procLog.ts';
import { ClaudeAgents } from './claudeAgents.ts';
import { PromptQueue } from './promptQueue.ts';
import { ChangeLog } from './changes.ts';
import { ActiveSkills } from './activeSkills.ts';
import { CodexAgents } from './codex/agents.ts';
import { generateImages } from './codex/images.ts';
import { APP_TOOLS, CODEX_TOOLS, PLUMBING, ToolLog, checklistKey, describeTool, planOf, protoKey, roundKey, uploadKey } from './tools.ts';
import { APP_TOOL_NAMES, CODEX_ONLY, appServer, codexInstalled, type Brokers, type ClaudeBroker, type CodexBroker, type SessionBroker } from './appTools.ts';
import { grantTools, TOOL_SERVERS, type ToolGrant } from './mcpHost.ts';
import { browserProxy } from './browserProxy.ts';
import { modServer } from './modTools.ts';
import { dataUrlImage, imageUrl, loadReplay, readReplayText, revokeAll } from './files.ts';
import { PLACEHOLDER_MAX, displayPath, isPlaceholder, oneLine, wakeOfNote, wakeOfSummary } from './text.ts';
import { Chapters, type TitleJob } from './chapters.ts';
import type { Titles } from './titles.ts';
import type { Voice } from './voice.ts';
import type { Phone } from './phone.ts';
import { CommandCache, learnTerminal, menuOf } from './commands.ts';
import type { ExplainRequest } from './explain.ts';
import { config, handoffAt } from './config.ts';
import { claudeBreakdown } from './contextUsage.ts';
import { connect } from './connect.ts';
import { tuning } from './profile.ts';
import { gitBranch } from './dirs.ts';
import { slowWindowsFolder } from './machine.ts';
import { clockNote } from './prompt.ts';
import { livePrompt } from './session/promptReload.ts';
import { EventLog } from './session/eventLog.ts';
import { CHROME, McpMenu } from './session/mcpMenu.ts';
import { PROGRESS_NOTE, PROGRESS_TOOL, guard } from './session/util.ts';
import { BROWSER_HOOK_SEC, BrowserGate, CHOICE_REPLY, agentKey } from './session/browserGate.ts';
import { Remote } from './session/remoteControl.ts';
import { Handoff, type HandoffDoc, type Held } from './session/handoff.ts';
import { originText } from './sessionOrigin.ts';
import { Asks, type AskPick, type UiPromptAsk } from './session/asks.ts';
import { MapFeed, TOAST_MS } from './session/sessionMap.ts';
import { SideCalls } from './session/sideCalls.ts';
import { Stream, type ResultMessage, type SystemMessage } from './session/stream.ts';
import { PanelFeed } from './session/panelFeed.ts';
import { UiReplyCheck } from './uiCheck.ts';

// Handoff runs well before the SDK's auto-compact, so it only counts below the model's window.
const handoffBelow = (max: number) => {
  const at = handoffAt();
  return at !== null && at < max ? at : null;
};

// context-handoff never compacts under the SDK, so the app runs the handoff itself (see session/handoff.ts).
// The mods ship in the repo; tarcsweb carries the bundled skills (grilling, learn-app, validate-pr) and no tools.
const WEB_MODS = [...MODS, 'tarcsweb'].map(modDir).join(':');

export type { HandoffDoc, Held, UiPromptAsk };

type ContentBlockParam = Exclude<SDKUserMessage['message']['content'], string>[number];

function fileBlock(f: Upload): ContentBlockParam {
  if (f.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: f.mime as 'image/png', data: f.data } };
  if (f.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name };
  return { type: 'text', text: `File ${f.name}:\n\n${f.data}` };
}

// A CLI warmed by typing that never got a message goes away after this.
const WARM_MS = 2 * 60_000;

const LAZY_TITLES = 10;

// What a session needs from the rest of the server.
export type Hub = {
  titles: Titles; voice: Voice; phone: Phone; limits: () => Limits | null; peers: (id: string) => SessionSummary[]; rateLimit: (info: SDKRateLimitInfo) => void;
  // The first plain permission waiting in an open session.
  peerAsk: (id: string) => PeerAsk | null;
  sessions: (id: string) => SessionBroker;
  commands: CommandCache;
  // Account-wide heads-ups (usage limits): dismissed once for every session, and kept across restarts.
  accountDismissed: (id: string) => boolean;
  dismissAccount: (id: string) => void;
  // A CLI started or went idle; the manager stops the least recently used idle ones past its cap.
  cliIdle: () => void;
};

// Public in the CLI protocol (get_task_output) but missing from the Query type in sdk.d.ts.
type TaskOutput = { output: string; total_bytes: number; truncated: boolean };
type WithTaskOutput = Query & { getTaskOutput?: (taskId: string) => Promise<TaskOutput> };

// Codex results waiting out a handoff before they reach the main agent.
const CODEX_HELD_MAX = 20;
// A notification this close to a turn's end may have missed it and woken the next turn instead.
const WAKE_LATE_MS = 3000;

export { oneLine };

// Dock and title names: the first few words, cut at a word boundary.
export function shortTitle(s: string, max = 40) {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : max).replace(/[\s,.;:!?-]+$/, '') + '…';
}

export type SessionInit = Settings & {
  newSession?: boolean;
  id: string;
  cwd: string;
  name: string;
  // The name in English for the notification voice; absent until the small model wrote it.
  spoken?: string;
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
  // A restored tab's browser choice, null meaning it still asks; absent, the session starts from the Settings default.
  browserChoice?: BrowserChoice | null;
};


// Forks that must never wait on the user or start agents.
const NO_CODEX = async (): Promise<never> => {
  throw new Error('Codex tools are not available here.');
};
const NO_ASK: Brokers = {
  round: async () => null, upload: async () => null, prototype: async () => null, checklist: async () => null,
  open: async () => {
    throw new Error('The Browser panel is not available here.');
  },
  codex: { start: NO_CODEX, message: NO_CODEX, stop: NO_CODEX, image: NO_CODEX },
};

// A queued message with no lifecycle event this long after a turn ended is treated as lost.
const QUEUE_LOST_MS = 10_000;
// A stop with no turn end this long after it offers Force stop.
const STOP_WAIT_MS = 12_000;
// A setting change the CLI never answers fails after this, so later changes are not stuck behind it.
const SETTING_MS = 15_000;
let uiCheckLogged = false;
const MODE_LABEL: Record<Mode, string> = { default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Bypass' };
type TurnEndKind = 'result' | 'cli_exit' | 'force_stop';
const TURN_LOST: Record<Exclude<TurnEndKind, 'result'>, string> = {
  cli_exit: 'Claude Code exited during the turn.',
  force_stop: 'Claude Code was force-stopped. The conversation is kept, and your next message resumes it.',
};

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
  // Set once the small model named the session from its first prompt, so the turn-end title call does not rename it again.
  private goalNamed = false;
  spoken: string | null = null;
  // False until the transcript exists on disk (a new session's first turn ended).
  private persisted: boolean;
  private pendingTitle: string | null = null;
  private done: Promise<void> | null = null;
  private unseenDone = false;
  private events: EventLog;
  private q: Query | null = null;
  private queue: PromptQueue | null = null;
  private asks: Asks;
  // Messages sent mid-turn that the CLI has not picked up yet.
  private queuedIds = new Set<string>();
  // What a queued message held, so it can be sent again as an interrupting one.
  private queuedMsgs = new Map<string, Held & { links: TextLink[] }>();
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Last warm-up, message or activity of the CLI: the LRU key for the manager's idle cap.
  usedAt = 0;
  // Last time the conversation moved (a send, a reply, a permission); 0 if only viewed.
  wroteAt = 0;
  // False while the current CLI is only warm, before any message reached it.
  private used = false;
  private stream: Stream;
  // True from the main thread's first reply message until its result, so release() never cuts a turn short.
  private turnOpen = false;
  // A prompt from the user (typed, queued, phone, handoff) will open the next turn; without one, the turn is an update.
  private prompted = false;
  // Notifications that may wake the agent, capped at WAKE_MAX; ones that arrived well before the last turn end were read in it.
  private wakes: (Wake & { at: number })[] = [];
  // A turn an agent's report opened, until it says something real: its text so far (past PLACEHOLDER_MAX it is a reply) and text ids.
  private quiet: { text: string; ids: string[] } | null = null;
  private turnEndAt = 0;
  // Counts working spells, so the Browser panel opens itself once per turn at most.
  private turnNo = 0;
  // Reports pushed to the CLI by app agents, by prompt uuid, until the CLI picks them up (capped at WAKE_MAX).
  private reportWakes = new Map<string, Wake>();
  private tracker: AgentTracker;
  private changes: ChangeLog;
  private panelFeed: PanelFeed;
  private codex: CodexAgents;
  // Claude subagents a Codex main started with claude_agent; their rows live in the tracker.
  private claude: ClaudeAgents;
  private codexHeld: string[] = [];
  // codex_agent calls seen in the stream, for a handler the CLI gave no tool_use id; capped at CODEX_HELD_MAX.
  private codexCalls: { id: string; key: string }[] = [];
  private hub: Hub;
  private chapters: Chapters;
  // Only sessions started here get an automatic name, and only until the user renames them.
  private createdHere: boolean;
  private userRenamed = false;
  private activity = '';
  private compacting = false;
  private compactions = 0;
  private lastCompact: { pre: number; post: number | null; trigger: string } | null = null;
  private compactError: string | null = null;
  private ctx: ContextUsage | null = null;
  private cost: number | null = null;
  // Sidebar preview only; never a second transcript buffer.
  private lastReply = '';
  private tokens: number | null = null;
  // Set once the cwd is found on a Windows drive under WSL.
  private slowFolder = false;
  private feed: MapFeed;
  private tools: ToolLog;
  private skills = new ActiveSkills();
  // Built on the first watch-load; its entries are capped inside WatchTimeline.
  private watch: WatchTimeline | null = null;
  private handover: Handoff;
  // A prompt sent while a turn ran may still be queued in the CLI; the handoff waits for the next turn end.
  private sentBusy = false;
  private mcp: McpMenu;
  // Set when a flag change (Chrome) waits for the turn to end before the CLI restarts.
  private cliStale = false;
  // The browser section the running CLI knows; a pack change mid-CLI rides on the next message as browserNote.
  private cliBrowser = '';
  private browserNote: string | null = null;
  // The browser subagent the running CLI registered, null for none; the SDK takes agents only at CLI start.
  private cliAgents: Record<string, AgentDefinition> | null = null;
  // Whether the running CLI got the Codex tools and prompt, so a handoff fork keeps the same prefix.
  private cliCodex = true;
  private gate: BrowserGate;
  // An early interrupt can still end the turn as 'success'; this keeps it reported as stopped.
  private stopRequested = false;
  // Armed by a stop and cleared by the turn end; when it fires, a heads-up offers Force stop.
  private stopWatch: ReturnType<typeof setTimeout> | null = null;
  private stuck = false;
  // Queued ids unqueue() is taking back, so their 'cancelled' lifecycle is not reported as lost.
  private cancelling = new Set<string>();
  // Setting changes, one at a time.
  private settingsChain: Promise<unknown> = Promise.resolve();
  private appMcp: McpServerConfig | null = null;
  // The mode an approved plan returns to unless the user picks another.
  private beforePlan: Mode;
  // The newest main-thread text item of the running turn; its tldr lands there.
  private lastTextId: string | null = null;
  // That item's text, held until turn end to check its ```ui blocks; one reply, capped in uiCheck.ts.
  private uiCheck = new UiReplyCheck();
  private side: SideCalls;
  // Plugins' band above the prompt.
  private surface: PluginSurface | null = null;
  private above: UiNode | null = null;
  // This process's slash commands; null until it answers, then the hub's cache stands in.
  private slash: SlashCommand[] | null = null;
  private commandListeners = new Set<(c: SlashItem[]) => void>();
  // The reply style the clients last asked for, and the one the running CLI was started with.
  private style: ReplyStyle = 'stretch';
  private cliStyle: ReplyStyle | null = null;
  // Which stretches of the last reply were opened; rides on the next prompt the CLI submits.
  private stretchNote: string | null = null;
  // Rides on the next prompt only, e.g. the folder change of a worktree branch.
  private onceNote: string | null = null;
  private remote: Remote;
  // Follows the model until the first message, then stays.
  provider: Provider;
  private sent: boolean;
  private cx: CodexMain | null = null;
  private toolGrant: ToolGrant | null = null;
  // The panel pack servers the grant lists.
  private grantKey = '';
  // Heads-up text for work a server restart cut off; cleared by the next message or a dismiss.
  private interrupted: string | null = null;
  // Set by close(), so a resend waiting on the old CLI's exit never starts one for a closed tab.
  private closed = false;

  private onChange: () => void;

  constructor(init: SessionInit, onChange: () => void, hub: Hub) {
    this.onChange = onChange;
    this.hub = hub;
    this.chapters = init.chapters ?? new Chapters();
    this.tools = init.tools ?? new ToolLog(init.cwd);
    this.createdHere = init.resumeId === null && !init.codexThreadId;
    this.id = init.id;
    this.events = new EventLog({ id: this.id, note: (e) => this.skills.note(e), mapChanged: () => this.mapChanged() });
    this.feed = new MapFeed({
      id: this.id, cwd: init.cwd,
      view: () => ({
        status: this.status, activity: this.activity, turnOpen: this.turnOpen, turnNo: this.turnNo, stuck: this.stuck, slowFolder: this.slowFolder,
        handoff: this.handover.state, ctx: this.ctx, cost: this.cost, tokens: this.tokens, compacting: this.compacting, compactions: this.compactions,
        compactError: this.compactError, lastCompact: this.lastCompact, above: this.above, interrupted: this.interrupted,
      }),
      cards: () => this.asks.cards, tracker: () => this.tracker, failedAgents: () => this.panelFeed.failedAgents, chapters: () => this.chapters.snapshot(),
      skills: () => this.skills.snapshot(this.slash ?? this.hub.commands.get(this.cwd)),
      peers: (id) => this.hub.peers(id), peerAsk: (id) => this.hub.peerAsk(id), limits: () => this.hub.limits(),
      accountDismissed: (id) => this.hub.accountDismissed(id), dismissAccount: (id) => this.hub.dismissAccount(id),
    });
    this.panelFeed = new PanelFeed({
      id: this.id, tracker: () => this.tracker, mapListening: () => this.feed.listening, mapChanged: () => this.mapChanged(), onChange: () => this.onChange(),
    });
    this.cwd = init.cwd;
    this.name = init.name;
    this.spoken = init.spoken ?? null;
    this.branch = init.branch;
    this.mode = init.mode;
    this.model = init.model;
    this.effort = init.effort;
    this.provider = providerOf(init.model);
    this.sent = init.resumeId !== null;
    if (this.provider === 'claude') this.effort = claudeEffort(this.effort);
    this.resumeId = init.resumeId;
    if (init.earlier) this.events.earlier = init.earlier;
    else if (init.resumeId && init.firstUuid) {
      const { resumeId: tid, firstUuid: uuid, cwd } = init;
      this.events.earlier = async () => {
        const path = await transcriptPath(cwd, tid);
        return historyOf(path ? await earlierMessages(path, uuid) : [], cwd).events;
      };
    }
    this.named = init.resumeId !== null;
    this.persisted = init.resumeId !== null;
    if (this.named && !this.spoken) this.askSpoken();
    // Saved MCP defaults win; otherwise a new session starts with the panel packs. Where browser work goes is the gate's choice.
    const mcpDefaults = init.newSession ? config.mcpDefaults : null;
    const packs = mcpDefaults ? [...mcpDefaults.keys] : init.newSession ? [PANEL_PACKS.playwright, PANEL_PACKS.devtools] : savedMcp(init.id);
    if (init.newSession) saveMcp(init.id, packs);
    this.mcp = new McpMenu({
      id: this.id, cwd: this.cwd, q: () => this.q, stale: () => this.cliStale,
      markStale: () => {
        this.cliStale = true;
      },
      busy: () => this.busy(), restartCli: () => this.restartCli(), restartForAgent: () => this.restartForAgent(),
      holdBrowser: () => this.holdBrowser(), syncBrowserNote: () => this.syncBrowserNote(), appMcp: () => this.appMcp,
      armIdle: () => this.armIdle(), toast: (t) => this.toast(t), push: (e) => this.push(e), onChange: () => this.onChange(),
    }, packs, mcpDefaults?.servers);
    this.gate = new BrowserGate({
      id: this.id, q: () => this.q, busy: () => this.busy(), turnNo: () => this.turnNo, packs: () => this.mcp.packs, cliChrome: () => this.mcp.cliChrome,
      ask: (card, signal) => this.asks.browserChoice(card, signal),
      changed: () => {
        this.syncBrowserNote();
        this.onChange();
      },
    }, init.browserChoice);
    this.remote = new Remote({
      id: this.id, cwd: this.cwd, q: () => this.q, provider: () => this.provider, name: () => this.name, resumeId: () => this.resumeId,
      ensureStarted: () => void this.ensureStarted(), armIdle: () => this.armIdle(), cliIdle: () => this.hub.cliIdle(), toast: (t) => this.toast(t), onChange: () => this.onChange(),
      phoneStart: (id, msg) => this.phoneStart(id, msg), handle: (m) => this.handleSafe(m),
    });
    this.handover = new Handoff({
      id: this.id, provider: () => this.provider, resumeId: () => this.resumeId, persisted: () => this.persisted, codexThreadId: () => this.codexThreadId,
      status: () => this.status, setStatus: (s) => this.setStatus(s), ctxUsed: () => this.ctx?.used ?? null,
      waiting: () => this.asks.waiting, agentsRunning: () => this.tracker.agentsRunning(),
      startTurn: (uuid, text) => {
        this.prompted = true;
        this.setStatus('working');
        this.remote.sent(uuid, text);
        this.ensureStarted().push({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null });
        this.used = true;
      },
      q: () => this.q,
      requestStop: () => {
        this.stopRequested = true;
      },
      push: (e) => this.push(e), chapter: (id, label) => this.chapters.start(id, label, Date.now()),
      send: (h) => this.send(h.text, h.pastes, h.files, h.thumbs, false, h.cid, undefined, h.links, h.origin), sendText: (text, origin) => this.send(text, [], [], [], false, undefined, undefined, [], origin),
      flushCodexHeld: () => this.flushCodexHeld(), baseOptions: () => this.baseOptions(NO_ASK),
      codexHandoff: (prompt, signal) => this.codexMain().writeHandoff(prompt, signal),
      nameSwitched: (name) => {
        this.named = true;
        // The first chapter is the handoff, so an automatic title would name the tab after it.
        this.userRenamed = true;
        this.autoName(name, null);
      },
      mapChanged: () => this.mapChanged(), onChange: () => this.onChange(),
    });
    this.asks = new Asks({
      id: this.id, cwd: this.cwd, phone: this.hub.phone, mode: () => this.mode,
      setMode: (m) => {
        this.mode = m;
      },
      beforePlan: () => this.beforePlan, remoteWanted: () => this.remote.wanted, stopRequested: () => this.stopRequested,
      clearActivity: () => {
        this.activity = '';
      },
      permission: (id, agentID, on, row) => this.tracker.permission(id, agentID, on, row),
      toast: (t) => this.toast(t), push: (e) => this.push(e), mapChanged: () => this.mapChanged(), onChange: () => this.onChange(), touch: () => this.touch(),
    });
    this.side = new SideCalls({
      id: this.id, provider: () => this.provider, persisted: () => this.persisted, resumeId: () => this.resumeId, baseOptions: () => this.baseOptions(NO_ASK),
      recentText: () => this.events.recentText(), push: (e) => this.push(e), wasDenied: (id) => this.asks.wasDenied(id),
    });
    this.stream = new Stream({
      cwd: this.cwd, tools: this.tools, intercept: (m) => this.remote.intercept(m), track: (m) => this.tracker.handle(m),
      lifecycle: (uuid, state) => this.onLifecycle(uuid, state), openTurn: () => this.openTurn(), replyDelta: (id, delta) => this.replyDelta(id, delta),
      replyText: (id, text, delta, synthetic) => this.replyText(id, text, delta, synthetic), activity: (t) => this.setActivity(t), push: (e) => this.push(e),
      touch: () => this.touch(), toolSeen: (id, name, input) => this.toolSeen(id, name, input), mainToolCall: (id, name, input) => this.mainToolCall(id, name, input),
      dropLogPartials: (id) => this.events.dropPartials(id), toolResult: (id, content, isError) => this.onToolResult(id, content, isError),
      result: (m) => this.onResult(m), rateLimit: (info) => this.hub.rateLimit(info), system: (m) => this.onSystem(m),
    });
    void slowWindowsFolder(this.cwd).then((slow) => {
      if (!slow) return;
      this.slowFolder = true;
      this.mapChanged();
    });
    this.beforePlan = init.mode === 'plan' ? 'default' : init.mode;
    this.tracker = new AgentTracker(this.cwd, {
      model: () => this.model, effort: () => this.effort, changed: () => this.panelChanged(),
      // Chapters are in the map, which a panel change no longer always rebuilds.
      edited: (path, add, rm) => {
        this.chapters.edited(path, add, rm);
        this.mapChanged();
      },
      read: (path) => {
        this.chapters.read(path);
        this.mapChanged();
      },
    });
    // A Codex tab reopened from the list gets its thread id as tab id, so its changes are kept under that id.
    const changesId = init.codexThreadId ?? this.id;
    this.changes = new ChangeLog(this.cwd, (card) => this.push({ type: 'changes', ...card }), (owner) => this.tracker.nameOf(owner) ?? 'Agent', changesId);
    this.codex = new CodexAgents({
      cwd: this.cwd, mode: () => this.mode, changed: () => this.panelChanged(),
      edited: (owner, path, before, after, note, add, rm) => {
        this.changes.recordTexts({ id: owner, main: false }, path, before, after, note);
        this.chapters.edited(displayPath(this.cwd, path), add, rm);
        this.mapChanged();
      },
      ask: (a) => this.asks.codexAsk(a),
      report: (text) => this.codexReport(text),
    });
    this.tracker.attach(this.codex);
    this.claude = new ClaudeAgents({
      cwd: this.cwd, mode: () => this.mode, tracker: this.tracker,
      ask: (row, name) => (toolName, input, opts) => this.asks.askTool(toolName, input, opts, { row, name }),
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
    return this.feed.map();
  }

  private get handingOff() {
    return this.handover.running;
  }

  private toast(text: string, ms = TOAST_MS) {
    this.feed.toast(text, ms);
  }

  subscribeMap(fn: (json: string) => void) {
    return this.feed.subscribe(fn);
  }

  mapChanged() {
    this.feed.changed();
  }

  dismiss(id: string) {
    this.feed.dismiss(id);
    if (id === 'interrupted') this.clearInterrupted();
  }

  markInterrupted(note: string) {
    this.interrupted = note;
    this.mapChanged();
    this.onChange();
  }

  get interruptedNote() {
    return this.interrupted;
  }

  private clearInterrupted() {
    if (!this.interrupted) return;
    this.interrupted = null;
    this.mapChanged();
    this.onChange();
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
    return this.asks.subscribeUiPrompt(fn);
  }

  answerUiPrompt(id: string, answer: UiPromptAnswer) {
    this.asks.answerUiPrompt(id, answer);
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
    const wantName = job.first && this.createdHere && !this.userRenamed && !this.goalNamed;
    this.hub.titles.request(job, wantName, (r) => {
      this.chapters.titled(job.id, r.title);
      if (wantName && r.name && !this.userRenamed && !this.goalNamed) this.autoName(r.name, r.spoken);
      this.mapChanged();
    });
  }

  // Named after the prompt's first words at once, then after its goal when the small model answers.
  private nameFromPrompt(label: string) {
    this.named = true;
    this.name = shortTitle(label);
    if (!this.createdHere) return this.askSpoken();
    void this.hub.titles.name(label).then((r) => {
      if (this.userRenamed) return;
      if (!r.name) return this.askSpoken();
      this.goalNamed = true;
      this.autoName(r.name, r.spoken);
    });
  }

  private askSpoken() {
    const name = this.name;
    this.spoken = null;
    this.hub.titles.speak(name, (spoken) => {
      if (this.name !== name || !spoken) return;
      this.spoken = spoken;
      this.onChange();
    });
  }

  private autoName(name: string, spoken: string | null) {
    this.name = name;
    if (spoken) this.spoken = spoken;
    else this.askSpoken();
    this.onChange();
    if (this.provider === 'codex') return this.codexMain().setName(name);
    if (!this.persisted) this.pendingTitle = name;
    else renameSession(this.resumeId!, name).catch((err) => this.push({ type: 'error', message: `Rename failed: ${String(err)}` }));
  }

  // Pull-only in the SDK, so it is asked after each turn and each compaction.
  private async refreshContext() {
    const q = this.q;
    if (!q) return;
    try {
      const r = await q.getContextUsage({ detail: 'summary' });
      const t = r.autoCompactThreshold;
      const compactAt = !r.isAutoCompactEnabled || !t ? null : t <= 100 ? Math.round(t) : Math.round((t / r.maxTokens) * 100);
      this.ctx = { pct: Math.round(r.percentage), used: r.totalTokens, max: r.maxTokens, compactAt, handoffAt: handoffBelow(r.maxTokens), breakdown: claudeBreakdown(r) };
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

  handoffNow(): string | null {
    return this.handover.now();
  }

  dismissHandoff() {
    this.handover.dismiss();
  }

  prepareSwitch(to: Provider): Promise<HandoffDoc> {
    return this.handover.prepareSwitch(to);
  }

  switched(tab: string): Held[] {
    return this.handover.switched(tab);
  }

  switchFailed(err: unknown) {
    this.handover.switchFailed(err);
  }

  private flushCodexHeld() {
    const notes = this.codexHeld;
    this.codexHeld = [];
    for (const n of notes) this.codexReport(n);
  }

  seedSwitch(doc: HandoffDoc, from: Provider, name: string, held: Held[], instruction?: string, origin?: import('./protocol.ts').SessionOrigin) {
    this.handover.seedSwitch(doc, from, name, held, instruction, origin);
  }

  async askWorktree(folder: string, signal = new AbortController().signal): Promise<boolean> {
    const question = `Another open session uses this git repository. Open ${folder} in its own worktree?`;
    const answer = await this.asks.canUseTool('AskUserQuestion', { questions: [{
      question, header: 'New session', multiSelect: false, options: [
        { label: 'Own worktree', description: 'A new branch at HEAD; uncommitted changes stay in the original checkout.' },
        { label: 'Shared folder', description: 'Both sessions may edit the same files.' },
      ],
    }] }, { signal, toolUseID: randomUUID(), requestId: randomUUID() });
    const picked = answer?.behavior === 'allow' ? (answer.updatedInput?.answers as Record<string, string> | undefined)?.[question] : undefined;
    if (picked !== 'Own worktree' && picked !== 'Shared folder') throw new Error('Opening cancelled: choose Own worktree or Shared folder.');
    return picked === 'Own worktree';
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

  toolOutput(id: string) {
    return this.tools.failedOutput(id);
  }

  subscribePanel(fn: (json: string) => void) {
    return this.panelFeed.subscribe(fn);
  }

  private panelChanged() {
    this.panelFeed.changed();
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
    this.remote.sent(uuid, text);
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
    this.dropQueued(ids, why);
    if (this.status === 'working' && !this.cx?.busy) this.codexTurnEnd(false, 'error_during_execution', null, null, false);
  }

  // Removes the bubbles of messages that will never be read and names them in one error.
  private dropQueued(ids: string[], why: string) {
    const lost: string[] = [];
    for (const id of ids) {
      this.queuedIds.delete(id);
      this.queuedMsgs.delete(id);
      const e = this.events.recentUser(id);
      if (!e) continue;
      lost.push(`"${oneLine(e.text || e.files?.map((f) => f.name).join(', ') || 'Pasted text', 60)}"`);
      this.push({ type: 'unqueued', id });
    }
    this.push({ type: 'error', message: lost.length ? `${why} Not sent: ${lost.join(', ')}.` : why });
  }

  // After a Claude turn ends, a queued message the CLI never picked up (no lifecycle event) counts as lost.
  private armQueueCheck() {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    if (this.cx || !this.queuedIds.size) return;
    const ids = [...this.queuedIds];
    this.queueTimer = setTimeout(() => guard('queue check', () => {
      this.queueTimer = null;
      // A turn running now may still read them; its own result checks again.
      if (this.status === 'working' || this.turnOpen) return;
      const lost = ids.filter((id) => this.queuedIds.has(id));
      if (!lost.length) return;
      this.dropQueued(lost, 'Claude Code did not pick up a queued message. Send it again.');
      if (this.cliStale && !this.busy()) {
        this.cliStale = false;
        void this.restartCli();
      }
      this.hub.cliIdle();
    }), QUEUE_LOST_MS);
  }

  // Messages queued in a CLI that is stopping; the next CLI gets them as fresh prompts, like held ones.
  private takeQueued() {
    if (this.cx || !this.queuedMsgs.size) return [];
    const out = [...this.queuedMsgs];
    this.queuedIds.clear();
    this.queuedMsgs.clear();
    return out;
  }

  private resend(msgs: [string, Held][]) {
    for (const [id, m] of msgs) {
      this.push({ type: 'unqueued', id });
      this.send(m.text, m.pastes, m.files, m.thumbs, false, undefined, undefined, m.links, m.origin);
    }
  }

  // The tab's grant on the app's MCP endpoint; generate_image stays out (Codex makes images natively), show_chart too (```ui blocks).
  // Built per MCP session, so the Claude tools follow the sign-in state at each thread start. Read at thread start, so a
  // changed set of panel packs gets a fresh grant that lists them.
  private codexTools() {
    const panel = new Map(this.codexBrowsers());
    const key = [...panel.keys()].join();
    if (this.toolGrant && this.grantKey !== key) {
      this.toolGrant.revoke();
      this.toolGrant = null;
    }
    this.grantKey = key;
    return (this.toolGrant ??= grantTools((name) => {
      const pack = panel.get(name);
      if (pack) {
        return browserProxy(pack, async (signal, id) => {
          await this.gate.choose(signal);
          browser.acquire(this.id, id, () => this.busy());
          await browser.ensure();
          browser.activity(browserToolOf(`mcp__${name}__`)!, this.id, this.turnNo);
        }, (id) => browser.release(this.id, id));
      }
      if (name !== 'app') return modServer(name);
      const claude = connect.status?.loggedIn === false ? undefined : this.claudeBroker;
      return appServer(this.brokers(claude), ['generate_image', 'show_chart']).instance;
    }, [...TOOL_SERVERS, ...panel.keys()]));
  }

  // The session's Playwright and DevTools servers, all pointed at the panel; Codex has no hooks, so a proxy gates them.
  private codexBrowsers() {
    return Object.entries(serversFor(this.mcp.packs)).filter(([name]) => ['playwright', 'devtools'].includes(browserToolOf(`mcp__${name}__`) ?? ''));
  }

  // The live handlers behind the app's MCP tools; forks get NO_ASK instead.
  private brokers(claude?: ClaudeBroker): Brokers {
    const browserChoice: Brokers['browserChoice'] = async (choice, signal) => {
      if (choice !== 'ask') this.gate.setChoice(choice);
      return CHOICE_REPLY[await this.gate.choose(signal)];
    };
    return { round: this.asks.askRound, upload: this.asks.askUpload, prototype: this.asks.askPrototype, checklist: this.asks.askChecklist, open: (url) => browser.openPage(url, this.id), codex: this.codexBroker, sessions: this.hub.sessions(this.id), browserChoice, ...(claude ? { claude } : {}) };
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
      text: (id, delta) => this.replyDelta(id, delta),
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
        if (this.codexThreadId) this.changes.keyAs(this.codexThreadId);
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
        const counts = u.last.totalTokens ? u.last : u.total;
        if (max) this.ctx = {
          pct: Math.round((used / max) * 100), used, max, compactAt: null, handoffAt: null,
          breakdown: { provider: 'codex', input: counts.inputTokens, cachedInput: counts.cachedInputTokens, cacheWriteInput: counts.cacheWriteInputTokens, output: counts.outputTokens, reasoning: counts.reasoningOutputTokens },
        };
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
          return await this.asks.codexAsk(a);
        } finally {
          this.tracker.permission(key, undefined, false);
        }
      },
      failedCommand: (id, command, output) => {
        this.tools.keepFailed(id, output);
        this.side.errorNote(id, command, output.slice(-OUTPUT_MAX), 'codex');
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
        const base = livePrompt.codexPromptOf(config.language, connect.status?.loggedIn !== false, this.codexBrowsers().length > 0);
        return this.style === 'stretch' ? `${base}\n\n${livePrompt.stretchGuide}` : base;
      },
      reminder: () => livePrompt.codexReminderOf(config.language),
      note: () => {
        const n = [clockNote(), this.stretchNote, this.asks.takeUiFailNote()].filter(Boolean).join('\n\n');
        this.stretchNote = null;
        return n;
      },
    };
  }

  // Claude's result handling, for a Codex turn; with more queued, the next turn starts right away and the tab stays working.
  private codexTurnEnd(ok: boolean, subtype: string, text: { id: string; text: string } | null, ms: number | null, more: boolean) {
    // A question card can outlive its call when Codex drops the request without cancelling it.
    this.asks.cancelChoices();
    this.asks.turnEnded();
    this.flushUiCheck();
    this.tracker.turnEnd(ok, undefined);
    this.changes.flush();
    this.changes.turnEnded();
    this.activity = '';
    const job = this.chapters.turnEnd(Date.now());
    if (job) this.requestTitle(job);
    this.push({ type: 'turn-end', ok: ok && !this.stopRequested, subtype });
    this.stopRequested = false;
    this.lastTextId = null;
    if (ok && text && this.style !== 'stretch') void this.side.summarize(text.id, text.text);
    if (more) return;
    if (ok) this.hub.phone.turnEnded(ms ?? 0, (t) => this.toast(t));
    if (!this.events.listening) this.unseenDone = true;
    this.doneAt = Date.now();
    this.setStatus('idle');
    this.onChange();
    this.touch();
    this.hub.cliIdle();
    this.refreshBranch();
  }

  // Every Claude turn end: its result, a CLI that ended mid-turn, or Force stop. before runs ahead of the
  // turn-end event, after right behind it, both before the tab goes idle.
  private endTurn(kind: TurnEndKind, ok: boolean, subtype: string, usage?: Record<string, ModelUsage>, hooks: { before?: () => void; after?: () => void } = {}) {
    this.clearStopWatch();
    this.stream.stop();
    // A call still streaming its input never gets a result; without one the client shows it running.
    for (const id of this.stream.partialIds()) this.push({ type: 'tool-result', id, error: kind === 'result' ? 'Stopped before the call was complete' : TURN_LOST[kind] });
    this.stream.turnEnded();
    this.asks.turnEnded();
    this.flushUiCheck();
    this.turnOpen = false;
    this.prompted = false;
    this.turnEndAt = Date.now();
    this.sentBusy = false;
    this.tracker.turnEnd(ok, usage);
    this.changes.flush();
    this.changes.turnEnded();
    this.activity = '';
    const job = this.chapters.turnEnd(Date.now());
    if (job) this.requestTitle(job);
    hooks.before?.();
    this.push({ type: 'turn-end', ok: ok && !this.stopRequested, subtype });
    if (kind !== 'result') this.push({ type: 'error', message: TURN_LOST[kind] });
    this.stopRequested = false;
    hooks.after?.();
    this.lastTextId = null;
    this.remote.phoneTurn = false;
    if (!this.events.listening) this.unseenDone = true;
    this.doneAt = Date.now();
    this.setStatus('idle');
    this.onChange();
    this.touch();
    this.armQueueCheck();
    this.hub.cliIdle();
    this.refreshBranch();
  }

  // The ui check is advisory: it must never stop a turn from ending.
  private flushUiCheck() {
    try {
      this.uiCheck.flush((itemId, index, type, why) => this.asks.uiBlockFailed(itemId, index, type, why));
    } catch (err) {
      if (!uiCheckLogged) console.error('ui block check failed:', err);
      uiCheckLogged = true;
    }
  }

  // A checkout during the turn moves the dock's branch, so this skips gitBranch's 30 s cache: one async git call per turn.
  private refreshBranch() {
    void gitBranch(this.cwd, 2000, true).then((b) => {
      if (this.closed || b === this.branch) return;
      this.branch = b;
      this.onChange();
    });
  }

  // The first turn's CLI died before writing a transcript: the next start must not resume a missing one.
  private forgetUnsaved() {
    if (this.persisted || this.resumeId !== this.id) return;
    void transcriptPath(this.cwd, this.id).then((path) => {
      if (this.persisted || this.q || this.resumeId !== this.id) return;
      if (path) this.markPersisted();
      else this.resumeId = null;
    }, () => {});
  }

  private clearStopWatch() {
    if (this.stopWatch) clearTimeout(this.stopWatch);
    this.stopWatch = null;
    if (!this.stuck) return;
    this.stuck = false;
    this.mapChanged();
  }

  // The heads-up's Force stop: ends the CLI and the turn; background agents go with the process.
  forceStop() {
    if (this.cx || (this.status !== 'working' && !this.turnOpen)) return this.clearStopWatch();
    this.handover.abort();
    this.handover.failWait('Claude Code was force-stopped', true);
    void this.stopCli();
    this.endTurn('force_stop', false, 'force_stop');
    this.forgetUnsaved();
    this.remote.resume();
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

  // A turn is still being written to the transcript.
  get turnRunning() {
    return this.status === 'working' || this.turnOpen || this.handingOff;
  }

  plainAsk(): PeerAsk | null {
    for (const [id, a] of this.asks.cards) if (a.card) return { sessionId: this.id, id, ...a.card };
    return null;
  }

  summary(): SessionSummary {
    return {
      activity: this.activity, cost: this.cost, lastReply: this.lastReply,
      id: this.id, name: this.name, cwd: this.cwd, branch: this.branch, state: this.dockState(),
      needsYou: this.asks.waiting, background: this.tracker.agentsRunning(), lastActive: this.lastActive, doneAt: this.doneAt, mode: this.mode, model: this.model, effort: this.effort,
      mcp: this.mcp.summary(), browserChoice: this.gate.choice,
      mcpCount: this.mcp.count, ...(this.remote.state ? { remote: this.remote.state } : {}), ...(this.interrupted ? { interrupted: true as const } : {}),
      provider: this.provider, caps: PROVIDER_CAPS[this.provider], fresh: !this.sent, ...(this.spoken ? { spoken: this.spoken } : {}),
    };
  }

  // The summary fields other sessions' maps read; their cached copy of it is rebuilt only when this changes.
  peerKey() {
    return `${this.name}\n${this.dockState()}\n${this.asks.waiting}\n${this.doneAt}\n${this.interrupted ? 1 : 0}`;
  }

  // The Codex thread behind this tab, once it has one; the session list and resume key Codex tabs by it.
  get codexThreadId() {
    return this.cx?.threadId ?? null;
  }

  subscribeMcp(fn: (json: string) => void) {
    return this.mcp.subscribe(fn);
  }

  mcpMenu() {
    return this.mcp.menu();
  }

  setBrowser(choice: BrowserChoice | null) {
    this.gate.setChoice(choice);
  }

  async setMcp(keys: string[], servers?: Record<string, boolean>, keepDefault?: boolean) {
    const names = () => this.codexBrowsers().map(([name]) => name).join();
    const before = names();
    await this.mcp.set(keys, servers, keepDefault);
    // A Codex thread lists its servers when it opens; an idle one reopens with the new panel packs (unload skips a busy one).
    if (names() !== before) this.cx?.unload();
  }

  refreshMcp() {
    return this.mcp.refresh();
  }

  mcpAuth(name: string): Promise<McpAuthReply> {
    return this.mcp.auth(name);
  }

  mcpReconnect(name: string): Promise<McpAuthReply> {
    return this.mcp.reconnect(name);
  }

  private mcpGone() {
    this.mcp.gone();
    this.holdBrowser();
  }

  // A running CLI learns a changed browser section with its next message.
  private syncBrowserNote() {
    if (!this.q) return;
    const text = livePrompt.browserPromptOf(this.gate.layers(), !!this.cliAgents);
    if (text !== this.cliBrowser) this.browserNote = text ? `The browser tools changed. Use this from now on:\n\n${text}` : 'The Browser section of your instructions no longer applies.';
    this.cliBrowser = text;
  }

  syncBrowserAgents() {
    return this.mcp.syncBrowserAgents();
  }

  private holdBrowser() {
    this.gate.hold();
  }

  // Agents are fixed at CLI start, so a changed browser subagent needs a fresh CLI, now or once the turn ends.
  // Returns whether it restarted now.
  private async restartForAgent() {
    if (!this.q || agentKey(this.gate.agent()) === agentKey(this.cliAgents)) return false;
    if (!this.busy()) {
      await this.restartCli();
      return true;
    }
    this.cliStale = true;
    this.mcp.changed();
    return false;
  }

  // The panel learned it cannot (or now can) host Claude in Chrome here; the badges and the prompt note follow.
  syncBrowserSupport() {
    this.holdBrowser();
    this.syncBrowserNote();
    void this.restartForAgent();
  }

  // A fresh CLI picks up flags and denied servers; it warms again so the MCP menu gets live states back.
  private async restartCli() {
    this.mcp.restarting = true;
    await this.stopCli();
    this.ensureStarted();
    this.remote.resume();
  }

  private dockState(): DockState {
    if (this.asks.waiting) return 'waiting';
    if (this.status === 'working' || this.handingOff) return 'working';
    return this.unseenDone ? 'done' : 'idle';
  }

  // Past messages go into the log before anyone subscribes.
  seed(events: TimedEvent[]) {
    this.events.seed(events);
  }

  backlog(seq: number) {
    return this.events.backlog(seq);
  }

  history(before: number, until?: number, id?: string): Promise<{ events: SeqEvent[]; older: number | null }> {
    return this.events.history(before, until, id);
  }

  find(query: string): Promise<{ hits: FindHit[]; more: boolean }> {
    return this.events.find(query);
  }

  subscribe(fn: (e: SeqEvent) => void) {
    const off = this.events.subscribe(fn);
    if (this.unseenDone) {
      this.unseenDone = false;
      this.onChange();
    }
    return off;
  }

  eventsAfter(seq: number) {
    return this.events.eventsAfter(seq);
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

  // A CLI warmed by typing whose message has not come yet.
  get warmFresh() {
    return !!this.q && !this.used && Date.now() - this.usedAt < WARM_MS;
  }

  // A live CLI that could be stopped without losing work. Remote Control needs it running.
  get idleCli() {
    // With no idle CLIs allowed (Lite), a CLI warmed for typing waits for its send; armIdle still stops it.
    return !!this.q && !this.busy() && !this.remote.wanted && (this.used || tuning().idleClis > 0);
  }

  // A Codex thread held in the shared app-server with no turn running; unloading it loses nothing.
  get idleThread() {
    return !!this.cx?.loaded && !this.busy();
  }

  setRemoteControl(on: boolean): Promise<string | null> {
    return this.remote.set(on);
  }

  // Claude's own queue dies with its process, so a message still queued there keeps the CLI alive.
  private busy() {
    return this.status === 'working' || this.turnOpen || this.handingOff || this.asks.waiting || this.tracker.hasRunning()
      || (!this.cx && this.queuedIds.size > 0);
  }

  // Pasted blocks travel with the prompt as plain text, ahead of what was typed; files go first as their own blocks.
  // cid is the client's id for the message: the echo carries it, and a retry of an already sent one is dropped.
  // links tie text spans to attachments; with any, the content interleaves them (server/links.ts).
  send(text: string, pastes: string[] = [], files: Upload[] = [], thumbs: (string | null)[] = [], now = false, cid?: string, seen?: StretchSeen, links: TextLink[] = [], origin?: import('./protocol.ts').SessionOrigin) {
    if (cid && this.echoed(cid)) return;
    this.clearInterrupted();
    if (this.handover.hold({ text, pastes, files, thumbs, cid, links, origin })) return;
    if (seen) this.stretchNote = livePrompt.noteOf(seen.opened, seen.unopened);
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
      this.queuedMsgs.set(id, { text, pastes, files, thumbs, links, origin });
    } else this.prompted = true;
    // The user spoke, so a silent agent turn needs no notice.
    this.quiet = null;
    this.push({ type: 'user', id, text, ...(origin ? { origin } : {}), ...(pastes.length ? { pastes } : {}), ...(shown.length ? { files: shown } : {}), ...(links.length ? { links } : {}), ...(queued ? { queued } : {}) });
    const typed = [...pastes, origin ? originText(text, origin) : text].filter((t) => t.trim()).join('\n\n');
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
      // How the hook joins several text blocks is not documented; an empty entry matches the next prompt.
      this.remote.sent(id, segs ? '' : typed);
      // The uuid comes back in command_lifecycle, which says when the CLI actually picks the message up.
      this.ensureStarted().push({ type: 'user', uuid: id, message: { role: 'user', content }, parent_tool_use_id: null, ...(now ? { priority: 'now' as const } : {}) });
      this.used = true;
      this.resumeId ??= this.id;
    }
    // A new session is named after its first prompt instead of its folder.
    if (!this.named) this.nameFromPrompt(label);
    this.tracker.turnStart();
    this.setStatus('working');
    this.touch();
  }

  // A retry follows its original closely, so only the recent end of the log is searched.
  private echoed(cid: string) {
    return !!this.events.recentUser(cid);
  }

  async rename(title: string) {
    this.name = title;
    this.named = true;
    this.userRenamed = true;
    this.askSpoken();
    this.onChange();
    if (this.provider === 'codex') this.codexMain().setName(title);
    else if (this.persisted) await renameSession(this.resumeId!, title);
    else this.pendingTitle = title;
  }

  answerPermission(id: string, allow: boolean, reply?: AskReply) {
    this.asks.answerPermission(id, allow, reply);
  }

  uiBlockFailed(itemId: string, index: number, type: string, why: string) {
    this.asks.uiBlockFailed(itemId, index, type, why);
  }

  noteOnce(text: string) {
    this.onceNote = text;
  }

  async interrupt() {
    this.tracker.markInterrupted();
    this.stopRequested = true;
    // A plan the user stopped is not one a handoff should resume.
    this.handover.planOpen = false;
    this.asks.cancelChoices();
    this.handover.abort();
    if (this.cx) return this.cx.interrupt();
    // Armed before the await, which itself can hang on a stuck CLI.
    if (this.q && (this.status === 'working' || this.turnOpen)) {
      this.stopWatch ??= setTimeout(() => guard('stop watchdog', () => {
        this.stopWatch = null;
        if (this.status !== 'working' && !this.turnOpen) return;
        this.stuck = true;
        this.mapChanged();
      }), STOP_WAIT_MS);
    }
    try {
      await this.q?.interrupt();
    } catch (err) {
      this.push({ type: 'error', message: `Interrupt failed: ${String(err)}` });
    }
  }

  settings(): Settings {
    return { mode: this.mode, model: this.model, effort: this.effort };
  }

  // Resolves to why the change failed, or null. The roster shows a new value only once the CLI took it.
  setMode(mode: Mode): Promise<string | null> {
    return this.inOrder(async () => {
      const prev = this.mode;
      const err = mode === prev ? null : await this.cliSet((q) => q.setPermissionMode(mode));
      if (!err) {
        this.mode = mode;
        if (mode !== 'plan') this.beforePlan = mode;
        this.onChange();
        return null;
      }
      const risk = prev === 'bypassPermissions' ? ', so tools still run without asking' : '';
      const message = `Could not switch to ${MODE_LABEL[mode]}: ${err}. ${MODE_LABEL[prev]} is still on${risk}.`;
      this.push({ type: 'error', message });
      this.onChange();
      return message;
    });
  }

  setModel(model: string, effort: Effort): Promise<string | null> {
    return this.inOrder(() => this.applyModel(model, effort));
  }

  private async applyModel(model: string, effort: Effort): Promise<string | null> {
    const provider = providerOf(model);
    if (provider !== this.provider) {
      if (this.sent) {
        this.onChange();
        return `This tab runs on ${this.provider === 'codex' ? 'Codex' : 'Claude'}. Start a new tab to use the other one.`;
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
      this.onChange();
      return null;
    }
    effort = claudeEffort(effort);
    const errors: string[] = [];
    if (model !== this.model) {
      const err = await this.cliSet((q) => q.setModel(model));
      if (err) errors.push(`Could not switch the model to ${model}: ${err}. Still on ${this.model}.`);
      else this.model = model;
    }
    if (effort !== this.effort) {
      const err = await this.cliSet((q) => q.applyFlagSettings({ effortLevel: effort }));
      if (err) errors.push(`Could not set effort to ${effort}: ${err}. Still ${this.effort}.`);
      else this.effort = effort;
    }
    this.onChange();
    for (const message of errors) this.push({ type: 'error', message });
    return errors.length ? errors.join(' ') : null;
  }

  private inOrder<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settingsChain.then(fn);
    this.settingsChain = run.catch(() => {});
    return run;
  }

  // Null when applied. With no CLI running the next start reads the new value; a CLI that replaced
  // this one during the call was started with the old value, so it gets the call too.
  private async cliSet(fn: (q: Query) => Promise<unknown>): Promise<string | null> {
    let q = this.q;
    for (let i = 0; q && i < 2; i++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude Code did not answer')), SETTING_MS);
      });
      try {
        await Promise.race([fn(q), late]);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (this.q === q) break;
      q = this.q;
    }
    return null;
  }

  // Resolves once the CLI process is gone.
  close() {
    this.codex.closeAll();
    this.claude.closeAll();
    // Interrupts the turn; the thread's pending approvals end as cancelled cards, and its MCP token stops working.
    this.dropCodex();
    this.asks.cancelChoices();
    this.hub.phone.cancel(this.id);
    this.side.close();
    this.handover.abort();
    this.handover.failWait('The session closed', false);
    revokeAll(this.id);
    this.events.close();
    this.remote.wanted = false;
    this.closed = true;
    return this.stopCli(false);
  }

  // Stops only the CLI process; the session stays open and the next intent or send starts a fresh one.
  private stopCli(requeue = true) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.clearStopWatch();
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    const queued = this.takeQueued();
    this.surface?.stop();
    this.surface = null;
    const q = this.q;
    this.q = null;
    this.turnOpen = false;
    this.queue?.close();
    this.queue = null;
    q?.close();
    this.mcpGone();
    this.remote.cliStopped();
    const done = this.done ?? Promise.resolve();
    // After the old process is gone, so its end does not reset the new one's state.
    if (queued.length && requeue) void done.then(() => !this.closed && this.resend(queued));
    return done;
  }

  private touch() {
    this.lastActive = this.usedAt = this.wroteAt = Date.now();
    this.armIdle();
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const thread = !!this.cx?.loaded;
    this.idleTimer = this.q || thread ? setTimeout(() => guard('idle release', () => this.release()), this.used || thread ? tuning().cliIdleMs : Math.min(WARM_MS, tuning().cliIdleMs)) : null;
  }

  // Stops the CLI so the next message starts one that re-reads the prompt, settings, skills and MCP config. Returns why it can't, if busy.
  async reload(): Promise<string | null> {
    if (this.status === 'working' || this.handingOff || this.asks.waiting) return 'Session is busy, try again when it finishes';
    if (this.tracker.hasRunning()) return 'Agents are still running, try again later';
    await this.stopCli();
    this.remote.resume();
    return null;
  }

  // Frees the CLI process when nothing depends on it; the next send resumes the transcript.
  release() {
    if (!this.q && !this.cx?.loaded) return;
    // Waiting out a busy spell is not activity, so it leaves lastActive and the LRU key alone.
    if (this.busy()) return this.armIdle();
    // A Codex thread resumes by id on the next send.
    if (this.cx?.loaded) this.cx.unload();
    if (!this.q) return;
    if (this.remote.wanted) return this.armIdle();
    void this.stopCli();
  }

  private push(e: ServerEvent) {
    this.events.push(e);
  }

  // A turn the CLI starts itself (a background agent's notification) sends no state change, so its reply marks it working.
  private openTurn() {
    if (this.handover.state?.phase === 'compacting') return;
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
    this.quiet = self && from.some((w) => w.via === 'agent') ? { text: '', ids: [] } : null;
    if (self) this.push({ type: 'wake', id: `wake:${randomUUID()}`, from });
  }

  private heard(id: string, delta: string) {
    const q = this.quiet;
    if (!q) return;
    if (!q.ids.includes(id)) q.ids.push(id);
    q.text += delta;
    if (q.text.trim().length > PLACEHOLDER_MAX) this.quiet = null;
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
    if (state === 'idle' && this.handover.afterSeed.length) {
      const held = this.handover.afterSeed;
      this.handover.afterSeed = [];
      queueMicrotask(() => {
        for (const h of held) this.send(h.text, h.pastes, h.files, h.thumbs, false, h.cid, undefined, h.links, h.origin);
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
    this.heard(id, delta);
    this.events.appendText(id, delta);
  }

  // A chunk of the main reply, streamed by Claude or Codex.
  private replyDelta(id: string, delta: string) {
    this.lastReply = ((this.lastTextId === id ? this.lastReply : '') + delta).slice(-240);
    this.lastTextId = id;
    this.uiCheck.add(id, delta);
    this.appendText(id, delta);
    this.chapters.text(delta);
    this.setActivity('Writing a reply');
  }

  // A main agent's tool call, from Claude's tool_use or a Codex item on one of our MCP servers.
  private mainToolCall(id: string, name: string, input: unknown) {
    const ev = this.tools.call(id, name, input);
    if (ev) this.push(ev);
    if (name === APP_TOOLS.round) this.asks.choiceSeen(id, name, roundKey(input));
    if (name === APP_TOOLS.upload) this.asks.choiceSeen(id, name, uploadKey(input));
    // A check never waits for the user, so it must not claim the card a later call with the same page waits on.
    if (name === APP_TOOLS.prototype && (input as { check?: unknown })?.check !== true) this.asks.choiceSeen(id, name, protoKey(input));
    if (name === APP_TOOLS.checklist) this.asks.choiceSeen(id, name, checklistKey(input));
    if (name === 'Bash') this.side.bashStarted(id, String((input as { command?: unknown })?.command ?? ''));
    if (name === 'TodoWrite' || name === APP_TOOLS.plan) this.handover.planOpen = !!planOf(name, input)?.steps.some((s) => s.status !== 'done');
    if (!PLUMBING.has(name)) this.setActivity(describeTool(this.cwd, name, input));
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
      if (then === 'now') this.send(msg.text, msg.pastes, msg.files, msg.thumbs, true, undefined, undefined, msg.links, msg.origin);
      return;
    }
    const q = this.q as (Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }) | null;
    if (!msg || !q?.cancelAsyncMessage) return;
    this.cancelling.add(id);
    const ok = await q.cancelAsyncMessage(id).catch(() => false).finally(() => this.cancelling.delete(id));
    if (!ok) return this.toast('Claude already read that message');
    this.queuedIds.delete(id);
    this.queuedMsgs.delete(id);
    this.push({ type: 'unqueued', id });
    if (then === 'now') this.send(msg.text, msg.pastes, msg.files, msg.thumbs, true, undefined, undefined, msg.links, msg.origin);
  }

  // pick is a round's answers or an upload's files.
  answerChoice(id: string, pick: AskPick) {
    this.asks.answerChoice(id, pick);
  }

  explain(req: ExplainRequest, deep: boolean, reply: (e: ExplainEvent) => void) {
    return this.side.explain(req, deep, reply);
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
    const own = input.hook_event_name !== 'UserPromptSubmit' || this.remote.ownPrompt(input.prompt);
    if (this.remote.wanted && !own) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PHONE_NOTE } };
    const notes = [clockNote(), livePrompt.visualReminder, this.browserNote, this.stretchNote, this.onceNote, this.asks.takeUiFailNote()].filter(Boolean);
    this.stretchNote = this.browserNote = this.onceNote = null;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notes.join('\n\n') } };
  };

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

  // Reverts wait for the turn and its agents, which may still be writing the same files.
  private revertBlocked() {
    if (this.status === 'working' || this.turnOpen) return 'Wait for the turn to end before reverting';
    if (this.tracker.hasRunning()) return 'Wait for the running agents to finish before reverting';
    return null;
  }

  revertChange(id: string, path: string, hunk: number | null) {
    const why = this.revertBlocked();
    return why ? Promise.resolve({ error: why, undo: null }) : this.changes.revert(id, path, hunk);
  }

  undoRevert(token: string) {
    const why = this.revertBlocked();
    return why ? Promise.resolve({ error: why, undo: null }) : this.changes.undo(token);
  }

  changeIndex() {
    return this.changes.index();
  }

  changeContext(id: string, path: string, from: number, count: number) {
    return this.changes.context(id, path, from, count);
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

  // The agents panel's Activity; Claude subagents share watch mode's timeline, built here if Watch never opened.
  async agentActivity(since: [string, number][]): Promise<WatchSub[]> {
    return this.tracker.activity(since, async (subs) => {
      const tid = this.transcriptId;
      if (!tid) return [];
      if (this.watch?.id !== tid) this.watch = new WatchTimeline(this.cwd, tid);
      return this.watch.subsSince(subs).catch(() => []);
    });
  }

  // Shared with the handoff fork, so its prompt prefix (system prompt, tools) matches the live one and hits the cache.
  private baseOptions(brokers: Brokers): Options {
    const off = this.mcp.off();
    // The live CLI's browser section, so a handoff fork keeps the same prompt prefix.
    const append = [livePrompt.visualPromptOf(this.cliCodex), this.cliBrowser, this.style === 'stretch' ? livePrompt.stretchGuide : ''].filter(Boolean).join('\n\n');
    return {
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      // A fresh server per process: an MCP server instance connects to one transport only. Charts are ```ui blocks now.
      // Without the Codex CLI its tools stay out, like their part of the prompt.
      mcpServers: { app: appServer(brokers, ['show_chart', ...(this.cliCodex ? [] : CODEX_ONLY)]) },
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
        ...(this.mcp.packs.includes(CHROME) ? { chrome: null } : {}),
      },
    };
  }

  private ensureStarted() {
    if (this.queue) return this.queue;
    const queue = new PromptQueue();
    this.cliAgents = this.gate.agent();
    this.cliBrowser = livePrompt.browserPromptOf(this.gate.layers(), !!this.cliAgents);
    this.browserNote = null;
    this.cliCodex = codexInstalled();
    const base = this.baseOptions(this.brokers());
    this.appMcp = base.mcpServers!.app;
    this.mcp.cliStarted();
    this.cliStyle = this.style;
    const options: Options = {
      ...base,
      mcpServers: { ...base.mcpServers, ...serversFor(this.mcp.packs) },
      allowedTools: APP_TOOL_NAMES,
      includePartialMessages: true,
      // Subagent text feeds the agents panel; the conversation still skips it.
      forwardSubagentText: true,
      // A short model-written status per subagent row, on task_progress; costs a small fork every ~30 s.
      agentProgressSummaries: tuning().agentSummaries,
      // The agents panel stops tasks one by one, so Esc only aborts the turn instead of killing background agents.
      perTaskStopAffordance: true,
      canUseTool: this.asks.canUseTool,
      hooks: {
        // The choice card and the browser check keep their own deadlines inside this timeout.
        PreToolUse: [{ matcher: '^(Agent|Task)$', hooks: [this.agentHook] }, { matcher: BROWSER_TOOLS, hooks: [this.gate.preHook], timeout: BROWSER_HOOK_SEC }],
        PostToolUse: [
          { matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [this.fileHook] },
          { matcher: BROWSER_TOOLS, hooks: [this.gate.doneHook] },
        ],
        PostToolUseFailure: [{ matcher: BROWSER_TOOLS, hooks: [this.gate.doneHook] }],
        PermissionDenied: [{ matcher: BROWSER_TOOLS, hooks: [this.gate.doneHook] }],
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
      ask: (a) => this.asks.composer(a),
      working: () => this.status === 'working',
    });
    this.surface = surface;
    void surface.start();
    this.mcp.poll(this.q);
    this.used = false;
    this.usedAt = Date.now();
    this.armIdle();
    this.hub.cliIdle();
    this.mcp.changed();
    this.holdBrowser();
    return queue;
  }

  private async consume(q: Query) {
    try {
      for await (const m of q) this.handleSafe(m);
    } catch (err) {
      if (this.q === q) {
        this.handover.failWait(err instanceof Error ? err.message : String(err), true);
        this.push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        // A CLI that died before reporting its servers failed to start, as far as the MCP menu goes.
        if (!this.mcp.live) this.mcp.error = oneLine(err instanceof Error ? err.message : String(err), 200);
      }
    } finally {
      // A released query is already replaced or gone; only a crash resets state here.
      if (this.q === q) {
        const midTurn = this.turnOpen || this.status === 'working';
        this.surface?.stop();
        this.surface = null;
        this.q = null;
        this.queue = null;
        this.handover.failWait('Claude Code stopped', false);
        this.mcp.restarting = false;
        if (midTurn) {
          this.endTurn('cli_exit', false, 'cli_exit');
          this.forgetUnsaved();
        } else {
          this.turnOpen = false;
          this.setStatus('idle');
        }
        this.mcpGone();
        this.remote.cliExited();
        // Not resent on its own: after a crash the user decides whether to send them again.
        if (!this.cx && this.queuedIds.size) this.dropQueued([...this.queuedIds], 'Claude Code stopped before it read a queued message.');
      }
      // Skipped when a newer process already took over.
      if (!this.q) this.tracker.processEnded();
    }
  }

  // A rename made before the transcript existed is saved now.
  private markPersisted() {
    this.persisted = true;
    // Default packs a new session started with stay on once it exists, so a restart resumes it the same way.
    if (this.mcp.packs.length && !savedMcp(this.id).length) saveMcp(this.id, this.mcp.packs);
    const title = this.pendingTitle;
    this.pendingTitle = null;
    if (title) renameSession(this.resumeId!, title).catch((err) => this.push({ type: 'error', message: `Rename failed: ${String(err)}` }));
  }

  // A throw would end the for-await, and the SDK's return() then kills the CLI and its background agents.
  private handleSafe(m: SDKMessage) {
    try {
      this.stream.handle(m);
    } catch (err) {
      console.error(`session ${this.id}: ${m.type} message failed:`, err);
      const message = `Could not process a ${m.type} message: ${err instanceof Error ? err.message : String(err)}`;
      guard('error event', () => this.push({ type: 'error', message }));
    }
  }

  private phoneStart(id: string, msg: PhoneMessage) {
    if (this.status !== 'working') this.stopRequested = false;
    this.push({ type: 'user', id, text: msg.text, ...(msg.files.length ? { files: msg.files } : {}), phone: true });
    const label = msg.text || msg.files.map((f) => f.name).join(', ');
    this.chapters.start(id, label, Date.now());
    this.changes.startTurn(id);
    this.activity = '';
    this.used = true;
    this.remote.phoneTurn = true;
    this.prompted = true;
    this.resumeId ??= this.id;
    if (!this.named) this.nameFromPrompt(label);
    this.tracker.turnStart();
    this.setStatus('working');
    this.touch();
  }

  private onLifecycle(uuid: string | undefined, state: string | undefined) {
    // 'cancelled' also ends a command that already started (its turn was aborted); only a never-started one is lost.
    if (uuid && (state === 'started' || state === 'completed')) this.deliver(uuid);
    else if (uuid && this.queuedIds.has(uuid) && !this.cancelling.has(uuid) && (state === 'cancelled' || state === 'discarded' || state === 'refused')) {
      this.dropQueued([uuid], state === 'refused' ? 'Claude Code refused a queued message.' : state === 'discarded' ? 'Claude Code ended before it read a queued message.' : 'Claude Code cancelled a queued message.');
    }
    this.handover.lifecycle(uuid, state);
  }

  private toolSeen(id: string, name: string, input: unknown) {
    if (!PLUMBING.has(name)) {
      this.chapters.tool();
      this.mapChanged();
    }
    if (name === CODEX_TOOLS.agent) {
      const o = (input ?? {}) as { description?: unknown; prompt?: unknown };
      this.codexCalls.push({ id, key: `${String(o.description ?? '')}\n${String(o.prompt ?? '')}` });
      if (this.codexCalls.length > CODEX_HELD_MAX) this.codexCalls.shift();
    }
  }

  private replyText(id: string, text: string, delta: string, synthetic: boolean) {
    if (!synthetic) this.lastReply = text.slice(-240);
    this.lastTextId = id;
    if (!synthetic) {
      this.heard(id, text);
      this.uiCheck.add(id, delta);
    }
    this.push({ type: 'text', id, delta });
    this.chapters.text(text);
  }

  private onToolResult(id: string, content: unknown, isError: boolean) {
    const ev = this.tools.result(id, content, isError);
    if (ev) this.push(ev);
    this.side.bashFinished(id, content, isError);
  }

  private onResult(m: ResultMessage) {
    // Only the result of the turn the handoff pushed answers its wait; a background turn's result goes the normal way.
    const ours = this.handover.ours;
    if (this.handover.isCompactResult(ours)) {
      this.turnOpen = false;
      this.usage(m.total_cost_usd, m.modelUsage, m.subtype === 'success');
      this.handover.compactResult(m.subtype === 'success', this.compactError);
      return;
    }
    const ok = m.subtype === 'success';
    const queued = this.sentBusy;
    this.usage(m.total_cost_usd, m.modelUsage, ok);
    let silent = false;
    const textId = this.lastTextId;
    this.endTurn('result', ok, m.subtype, m.modelUsage, {
      before: () => {
        void this.refreshContext().then(() => this.handover.maybe(queued));
        // An agent's report woke Main and it ended without a real reply; the notice offers to ask for the result.
        const quiet = this.quiet;
        this.quiet = null;
        silent = !!quiet && ok && !this.stopRequested && isPlaceholder(quiet.text);
        if (quiet && silent) this.push({ type: 'quiet', id: `quiet:${randomUUID()}`, ...(quiet.ids.length ? { hide: quiet.ids } : {}) });
      },
      after: () => {
        // A local command (/usage, /context) answers without a model turn: no recap or summary for it.
        if (ok && !m.is_error && m.num_turns > 0) {
          if (textId && !silent && this.cliStyle !== 'stretch') void this.side.summarize(textId, m.result);
          // A turn sent from the phone already shows its end there.
          if (!this.remote.phoneTurn) this.hub.phone.turnEnded(m.duration_ms, (t) => this.toast(t));
        }
        if (!this.persisted) this.markPersisted();
      },
    });
  }

  private onSystem(m: SystemMessage) {
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
      const ours = this.handover.state?.phase === 'compacting';
      this.compacting = false;
      this.compactError = null;
      this.compactions++;
      this.lastCompact = { pre: c.pre_tokens, post: c.post_tokens ?? null, trigger: ours ? 'handoff' : c.trigger };
      this.skills.compacted();
      if (ours) this.handover.compacted(c.pre_tokens, c.post_tokens ?? null);
      this.mapChanged();
      void this.refreshContext();
    }
    // Mods' $.ui.toast; the SDK types do not list this subtype.
    const raw = m as unknown as { subtype?: string; text?: string; timeout_ms?: number; state?: string; detail?: string; failure_kind?: string };
    if (raw.subtype === 'ui_toast' && raw.text) this.toast(raw.text, raw.timeout_ms ?? TOAST_MS);
    if (raw.subtype === 'bridge_state') this.remote.bridge(raw.state, raw.detail, raw.failure_kind);
    if (raw.subtype === 'ui_invalidate') this.surface?.invalidate();
    if (m.subtype === 'commands_changed') this.setCommands(m.commands);
  }
}
