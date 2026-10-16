// Wire protocol shared by the server and the web client (JSON over one WebSocket at /ws).

export type Status = 'working' | 'idle';
// What the dock shows per session; 'done' means a turn ended while nobody was watching.
export type DockState = 'working' | 'waiting' | 'idle' | 'done';
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_IDS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

export type Settings = { mode: Mode; model: string; effort: Effort };
// How replies are written: stretchtext (`{{short|long}}`) or full text with a TL;DR on long ones. A browser pref.
export type ReplyStyle = 'stretch' | 'summary';
export const REPLY_STYLES: ReplyStyle[] = ['stretch', 'summary'];
// Which stretches of the last reply the reader opened (short forms), sent with the next message.
export type StretchSeen = { opened: string[]; unopened: string[] };

// Whether the CLI can run: cli is the `claude` on PATH; loggedIn comes from the binary the SDK spawns.
// email and plan ("Claude Max") are for the local user's eyes only, never logged.
export type ConnectStatus = { cli: { path: string; version: string | null } | null; loggedIn: boolean; method: string | null; email: string | null; plan: string | null; error: string | null; checkedAt: number };
// `claude auth login` run by the server: url appears once the CLI prints it; error is the CLI's last failure line.
export type LoginState = { state: 'idle' | 'starting' | 'waiting' | 'verifying' | 'signing-out'; url: string | null; error: string | null };
export type ConfigLanguage = 'en' | 'pt-BR';
// The editable part of the config file; the ntfy topic is shown to the local user only.
// handoffAt is the threshold in effect, null when off.
export type SettingsView = { language: ConfigLanguage; ntfy: { topic: string; server: string } | null; handoffAt: number | null; youShouldKnow: boolean; path: string };
// Only the keys being changed; ntfy true makes a random topic, false clears it. handoffAt false turns it off.
export type SettingsPatch = { language?: ConfigLanguage; ntfy?: boolean; handoffAt?: number | false; youShouldKnow?: boolean };

// The app's own releases (server/update.ts). canUpdate is false for a git clone or a dev server, and why says how to update instead.
// checkError is a quiet note (offline, rate limit); run is the last in-app update, with the failure reason in message.
export type UpdateStep = 'downloading' | 'installing' | 'checking' | 'restarting' | 'done' | 'failed';
export type UpdateRun = { step: UpdateStep; tag: string; at: number; message: string };
export type UpdateStatus = {
  current: string;
  repo: string;
  latest: { tag: string; version: string; url: string } | null;
  available: boolean;
  canUpdate: boolean;
  why: string | null;
  checking: boolean;
  checkedAt: number | null;
  checkError: string | null;
  run: UpdateRun | null;
  log: string;
};

// Rich tool calls: the mods' visuals and the app's own MCP tools, rendered as frames instead of rows.
export type DiffLine = ['-' | '+' | ' ', string];
export type DiffDetail = { kind: 'diff'; path: string; add: number; rm: number; lines: DiffLine[]; more: number; created: boolean };
export type ChartType = 'bar' | 'line' | 'area' | 'stat';
export type ChartSpec = { type: ChartType; title: string; unit: string; labels: string[]; series: { name: string; values: number[] }[] };
export type Align = 'left' | 'right' | 'center';
export type TableSpec = { title: string; note: string; columns: string[]; rows: string[][]; align: Align[] };
export type StepStatus = 'todo' | 'doing' | 'done';
export type PlanSpec = { title: string; steps: { text: string; status: StepStatus }[] };
export type ChoiceSpec = { question: string; options: { label: string; description: string }[] };
// recommended is an option index (never preselected); why explains that pick.
export type RoundQuestion = { title: string; setup: string; options: { label: string; description: string }[]; recommended: number | null; why: string };
export type RoundSpec = { title: string; questions: RoundQuestion[] };
// One ask_round answer: a picked option, a note, both, or neither (unanswered).
export type RoundPick = { option: number | null; note: string };
export type RichDetail =
  | { kind: 'visual'; html: string; width: number; height: number; durationMs: number; title: string }
  | { kind: 'replay'; title: string; page: number }
  | { kind: 'chart'; chart: ChartSpec }
  | { kind: 'table'; table: TableSpec }
  | { kind: 'plan'; plan: PlanSpec }
  | { kind: 'choice'; choice: ChoiceSpec }
  | { kind: 'round'; round: RoundSpec };
export type ToolDetail = DiffDetail | RichDetail;
// One agent's file changes in one user turn; owner is its agents panel row id. The full diff loads with changes-load.
export type ChangeFile = { path: string; add: number; rm: number; created: boolean; note?: string };
export type ChangeCard = { id: string; turn: string; owner: string; main: boolean; name: string; files: ChangeFile[]; add: number; rm: number; more: number };
// a and b are the hunk's first line numbers before and after; note says why a file has no diff.
export type FileDiff = { path: string; add: number; rm: number; created: boolean; note: string | null; hunks: { a: number; b: number; lines: DiffLine[] }[]; truncated: boolean };

// A file sent with a prompt: images and PDFs go to the model as blocks, text files as text.
export type FileKind = 'image' | 'pdf' | 'text';
export type Upload = { name: string; kind: FileKind; mime: string; data: string };
// What the conversation shows for a sent file; thumb and src are signed URLs of the small and full picture.
export type Attachment = { name: string; kind: FileKind; thumb?: string; src?: string };
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Longest side of the server thumbnail a signed image URL serves with ?w=THUMB_SIDE.
export const THUMB_SIDE = 640;

export type ServerEvent =
  // pastes: long pasted blocks sent with the prompt, shown as chips.
  // queued: sent while Claude works; it waits until the CLI picks it up ('delivered').
  // stopped: interrupted before Claude answered it. phone: sent through Remote Control (Claude app or claude.ai).
  | { type: 'user'; id: string; text: string; pastes?: string[]; files?: Attachment[]; queued?: boolean; stopped?: boolean; phone?: boolean }
  | { type: 'delivered'; id: string }
  | { type: 'unqueued'; id: string }
  | { type: 'text'; id: string; delta: string }
  // verb is the row label ("read", "edit", "run"); partial calls are still streaming their input; fold hides
  // this call inside the rich item with that id (a Read of a render_ui picture).
  | { type: 'tool'; id: string; name: string; verb: string; summary: string; detail?: ToolDetail; partial?: boolean; fold?: string; replaces?: string }
  // choice is the picked option index for ask_choice (null when nobody answered); png is a render_ui picture.
  // round holds ask_round's answers in question order (null when the round was cancelled).
  | { type: 'tool-result'; id: string; error: string | null; choice?: number | null; answer?: string; round?: RoundPick[] | null; png?: string; img?: string }
  // id is the tool_use id, so the card replaces that tool's line.
  // questions: an AskUserQuestion call; plan: an ExitPlanMode call waiting for approval, back the mode it returns to by default.
  | { type: 'permission'; id: string; tool: string; summary: string; title?: string; defaultToNo?: boolean; detail?: DiffDetail; questions?: Question[]; plan?: string; back?: Mode }
  // elsewhere: answered on the phone through Remote Control first, so allow says nothing.
  | { type: 'permission-resolved'; id: string; allow: boolean; reply?: AskReply; elsewhere?: boolean }
  | { type: 'turn-end'; ok: boolean; subtype: string }
  | { type: 'status'; state: Status }
  | { type: 'error'; message: string }
  // Haiku's short summary of a long answer; id is that answer's text item.
  | { type: 'tldr'; id: string; text: string; words: number }
  // A plain explanation of a failed Bash call; id is the tool_use id.
  | { type: 'tool-note'; id: string; text: string }
  // Sent again with the same id each time that agent's changes grow.
  | ({ type: 'changes' } & ChangeCard);

// at: epoch ms when the server emitted it, or the transcript time in resumed history. Later chunks of a text block omit it.
export type TimedEvent = ServerEvent & { at?: number };
export type SeqEvent = TimedEvent & { seq: number; sessionId: string };

// A row holding search matches: id is the event id the client keys the row by, seq where it sits (for history-load), n the matches in it.
export type FindHit = { id: string; seq: number; n: number };

// Watch mode's compact timeline of the whole transcript, loaded with watch-load. No text, diffs or images.
// s: the file path for file tools, else a one-line summary; end: when the call's result came; turn-end ids are synthetic.
export type WatchKind = 'user' | 'text' | 'tool' | 'plan' | 'agent' | 'permission' | 'error' | 'turn-end';
export type WatchEntry = {
  k: WatchKind; id: string; at: number | null; end?: number;
  verb?: string; s?: string; add?: number; rm?: number; created?: true; err?: true;
  plan?: PlanSpec; state?: AgentState;
};
// page echoes the request's before; before is the cursor for the next older page, null once this page reaches the start.
export type WatchPage = { entries: WatchEntry[]; page: number | null; before: number | null; error?: string };

// Agents panel: a live snapshot per session, sent outside the replay log.
export type AgentState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
export type FileTouch = { path: string; mode: 'edited' | 'read'; add: number; rm: number; at: number };
export type Steps = { total: number; done: number; avgMs: number | null; lastAt: number; task: string };
export type AgentRow = {
  // 'main' for the session's own thread, else the spawning Agent tool_use id.
  id: string;
  taskId: string | null;
  main: boolean;
  name: string;
  model: string;
  effort: string | null;
  state: AgentState;
  startedAt: number;
  endedAt: number | null;
  tokens: number | null;
  window: number | null;
  steps: Steps | null;
  // Step names reported through the progress tool for the current task, oldest first; last = current.
  stepLog: string[];
  now: string;
  files: FileTouch[];
  // The last line it wrote; the full text, task and report load with agent-load.
  said: string;
  // Bumps whenever the long text changes, so an open detail knows to load it again.
  rev: number;
  // Messages sent to it after spawn (SendMessage): how many, and the newest as one line.
  followUpCount: number;
  lastFollowUp: string | null;
  canStop: boolean;
  // 'pi' rows come from the pi-agent runner's log; canMessage: the panel can send it a message.
  kind: 'claude' | 'pi';
  canMessage: boolean;
};
export type ProcState = 'running' | 'done' | 'failed' | 'stopped';
// exit is read from the notification summary text; the SDK has no numeric exit code field.
// label: the Bash tool's short description, when the call had one.
export type ProcRow = { id: string; command: string; label: string | null; state: ProcState; startedAt: number; endedAt: number | null; summary: string | null; exit: number | null };
export type Panel = { active: boolean; agents: AgentRow[]; procs: ProcRow[] };
// On the wire: full on subscribe, then only changed rows; an order lists every row id and comes only when the ids changed.
export type PanelPatch = { active: boolean; full: boolean; agents: AgentRow[]; procs: ProcRow[]; agentOrder?: string[]; procOrder?: string[] };
// A row's long text: the prompt a subagent got, its output so far (last 6 KB), its report ('' and null for main) and follow-ups.
export type AgentText = { rev: number; task: string; text: string; result: string | null; followUps: { at: number; text: string }[] };
// live: the CLI's own tail of the output; file: the output_file the SDK named; redirect: the file the command
// itself writes to (path on proc-log); summary: none was readable.
export type LogSource = 'live' | 'file' | 'redirect' | 'summary';

// Session map: one chapter per user prompt, plus heads-up notes and usage, sent as a snapshot like the panel.
export type ChapterFile = { path: string; add: number; rm: number };
export type Chapter = {
  // The id of the user event that opened it, so the client can scroll to that node.
  id: string;
  title: string;
  startedAt: number | null;
  endedAt: number | null;
  files: ChapterFile[];
  tools: number;
  reads: number;
};
export type HeadsUpAction = { kind: 'review' | 'log' | 'switch'; target: string };
export type HeadsUp = { id: string; need: boolean; text: string; detail: string; action: HeadsUpAction | null; dismissable: boolean };
// compactAt is the SDK's auto-compact in %; handoffAt is the context-handoff mod's threshold in tokens.
export type ContextUsage = { pct: number; used: number; max: number; compactAt: number | null; handoffAt: number | null };
export type SessionUsage = { ctx: ContextUsage | null; cost: number | null; tokens: number | null; compacting: boolean };
// The app's own context handoff: write the doc in a fork, compact, then hand it over. steps holds each phase's start time.
export type HandoffPhase = 'writing' | 'compacting' | 'handing' | 'done' | 'failed';
export type HandoffState = {
  phase: HandoffPhase; steps: Partial<Record<HandoffPhase, number>>; startedAt: number; endedAt: number | null;
  pre: number | null; post: number | null; path: string | null; error: string | null;
  // Previews of messages the user sent meanwhile; they go out once the handoff ends.
  held: string[];
};
// The hand-over message starts with this; old transcripts show it as a card too. A compaction summary starts with the other.
export const HANDOFF_PREFIX = 'The conversation was just compacted. A handoff document written right before it is at ';
export const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';
// A message typed in the agents panel for a Claude subagent; the main thread relays it with SendMessage.
export const AGENT_NOTE_PREFIX = '[Message for agent ';
export const agentNote = (name: string, agentId: string, text: string) =>
  `${AGENT_NOTE_PREFIX}"${name}" · ${agentId}]\nThe user typed this in the agents panel. Forward it to that agent word for word with SendMessage (to: "${agentId}"), then go on with what you were doing.\n\n${text}`;
// A mod's $.ui.toast, shown until `until` (epoch ms).
export type Toast = { id: string; text: string; until: number };
// A tree a plugin's ui.render hook drew for the band above the prompt; strings are text. Buttons carry the press to send back.
export type UiPress = { plugin: string; handle: number };
export type UiElement = { type: string; props?: Record<string, unknown>; children?: UiNode[]; press?: UiPress };
export type UiNode = string | UiElement;
// The CLI asks the composer through the server: read its text, fill it, or show a suggestion.
export type UiPromptOp = 'read' | 'fill' | 'suggest';
export type UiPromptAnswer = { text?: string; cursor?: number; filled?: boolean; shown?: boolean };
// above: plugins' band above the prompt (null when none draws).
export type SessionMap = { chapters: Chapter[]; now: string; need: boolean; headsUps: HeadsUp[]; usage: SessionUsage; handoff: HandoffState | null; toasts: Toast[]; above: UiNode | null };
export type LimitKey = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';
// pct is 0-100; resetsAt is epoch ms.
export type LimitWindow = { pct: number | null; resetsAt: number | null };
export type Limits = { windows: Partial<Record<LimitKey, LimitWindow>>; status: 'allowed' | 'allowed_warning' | 'rejected'; type: string | null; resetsAt: number | null };

export type SessionSummary = Settings & {
  id: string;
  name: string;
  cwd: string;
  branch: string | null;
  state: DockState;
  needsYou: boolean;
  // Agents or processes still running after the turn ended.
  background: boolean;
  lastActive: number;
  // When the last turn ended; unlike lastActive, background agents do not move it.
  doneAt: number;
  mcp: McpPack[];
  // The MCP chip: servers on (built-ins excluded) and whether one failed. Absent from older servers.
  mcpCount?: { on: number; bad: boolean };
  // Absent while Remote Control is off.
  remote?: RemoteState;
};

// Remote Control: the session continues on claude.ai/code or the Claude app. url is its page there, once known.
export type RemoteState = { state: 'connecting' | 'on' | 'error'; url: string | null; error?: string };

// One optional MCP set from ~/.claude/mcp; state is the worst status of its servers once known.
export type McpPack = { key: string; on: boolean; state?: 'connected' | 'pending' | 'failed' | 'needs-auth'; error?: string };

// Where an MCP server comes from: a ~/.claude/mcp pack, ~/.claude.json, the folder (.mcp.json or local scope), claude.ai, a plugin, or the app itself.
export type McpGroup = 'pack' | 'user' | 'project' | 'claudeai' | 'plugin' | 'other' | 'builtin';
// One row of the MCP menu. key is the pack key for packs, the server name otherwise.
// locked: built-ins, and servers switched off in Claude Code's own /mcp for this folder ('disabled').
// pending: the choice is saved but the running Claude Code still has the old one until it restarts.
export type McpRow = {
  key: string; group: McpGroup; on: boolean; locked?: boolean;
  state?: McpPack['state'] | 'disabled'; error?: string; tools?: number; pending?: true;
};
// What the session's Claude Code is doing about MCP: booting, restarting for a change, or waiting for the turn to end first.
export type McpPhase = 'starting' | 'restarting' | 'waiting';
// A sign-in answer: url opens in a browser tab; manual means the app must reconnect once the user is back (claude.ai connectors).
export type McpAuthReply = { url?: string; manual?: true; checked?: true; error?: string };

export type PastSession = { id: string; name: string; cwd: string; branch: string | null; lastModified: number; archived: boolean };
export type Folder = { path: string; branch: string | null; hasChildren: boolean };
export type Dir = Folder & { name: string };
// Sessions tagged with this are hidden from the palette's normal list.
export const ARCHIVED_TAG = 'archived';

export type ServerMessage =
  | SeqEvent
  // The backlog after a hello, applied in one render. replace: drop what is held and start from these (the log's newest
  // part); older is then the history-load cursor, null at the start.
  | { type: 'events'; sessionId: string; events: SeqEvent[]; replace?: true; older?: number | null }
  // Answer to history-load, oldest first; before echoes the request, older is the cursor for the next page.
  | { type: 'history'; sessionId: string; before: number; events: SeqEvent[]; older: number | null; error?: string }
  // Answer to history-find over the whole session, oldest first; more: the match cap cut the list.
  | { type: 'history-found'; sessionId: string; query: string; hits: FindHit[]; more: boolean; error?: string }
  // Reply to a subscribe, sent before the replay. A new serverId means every log restarted.
  // defaults: the settings a new session starts with, from the user's config.
  | { type: 'hello'; serverId: string; reset: boolean; sessionId: string | null; found: boolean; defaults: Settings }
  | { type: 'sessions'; open: SessionSummary[] }
  | { type: 'past'; sessions: PastSession[]; folders: Folder[]; home: string }
  | { type: 'opened'; sessionId: string }
  | { type: 'dirs'; path: string; branch: string | null; dirs: Dir[] }
  | { type: 'dirs'; path: string; error: string }
  | { type: 'found'; query: string; dirs: Dir[] }
  // No tone means an error.
  | { type: 'notice'; message: string; tone?: 'info' }
  // The server is quitting on purpose (tray Quit), so the page closes instead of reconnecting.
  | { type: 'bye' }
  | ({ type: 'panel'; sessionId: string } & PanelPatch)
  // null when that row is gone from the panel.
  | { type: 'agent-detail'; sessionId: string; id: string; detail: AgentText | null }
  | { type: 'proc-log'; sessionId: string; taskId: string; text: string; truncated: boolean; source: LogSource; path?: string }
  | ({ type: 'map'; sessionId: string } & SessionMap)
  // Plan limits are account-wide, so they go to every client.
  | { type: 'limits'; limits: Limits }
  | ({ type: 'replay'; sessionId: string; id: string } & ReplayInfo)
  // Spoken recaps go to every client; the global switch too.
  | VoiceClip
  | ReplayVoice
  // on is null when the server has no TTS installed.
  | { type: 'voice-on'; on: boolean | null }
  | SttMessage
  // Sent on connect and after each check; the server checks only at boot and on connect-check.
  | { type: 'connect-status'; status: ConnectStatus }
  // Goes to every client whenever the sign-in or sign-out flow moves.
  | { type: 'login'; login: LoginState }
  // Answer to settings-load, or to settings-set with its id; error is null when it saved.
  | { type: 'settings'; settings: SettingsView; reply?: { id: string; error: string | null } }
  // Sent on connect and to every client whenever a check or an update moves.
  | { type: 'update'; update: UpdateStatus }
  // Answers to this client's explain requests; outside the replay log.
  | ExplainEvent
  // A plugin asks the composer of a client showing this session; answered with ui-prompt-answer.
  | { type: 'ui-prompt'; sessionId: string; id: string; op: UiPromptOp; text?: string; mode?: string }
  // The composer's slash menu; sent on subscribe and whenever the CLI's list changes.
  | { type: 'commands'; sessionId: string; commands: SlashItem[] }
  // The MCP menu, sent on mcp-status and whenever it changes; live is false while no CLI runs, so states are unknown.
  | { type: 'mcp'; sessionId: string; servers: McpRow[]; live: boolean; phase?: McpPhase; error?: string }
  // Answers this client's mcp-auth or mcp-reconnect.
  | ({ type: 'mcp-auth'; sessionId: string; server: string } & McpAuthReply)
  // The file tree: one folder or one file of the session folder; path is relative to it, '' for the root.
  | ({ type: 'tree'; sessionId: string; path: string } & ({ entries: TreeEntry[]; more: number } | { error: string }))
  | ({ type: 'tree-file'; sessionId: string; path: string } & TreeFile)
  | { type: 'changes-detail'; sessionId: string; id: string; path: string; diff: FileDiff | null }
  | WatchTimelineMessage;

// Answer to watch-load, oldest first.
export type WatchTimelineMessage = { type: 'watch-timeline'; sessionId: string } & WatchPage;

export type TreeEntry = { name: string; dir: boolean; link?: true };
// text is null for binary, too large or failed reads.
export type TreeFile = { text: string | null; size: number; binary: boolean; tooLarge: boolean; error?: string };

// A /command the composer offers; skill marks one defined by a user, project, plugin or MCP server.
export type SlashItem = { name: string; description: string; hint: string; aliases?: string[]; skill?: boolean };

// The explain panel: an answer's text comes first, its drawing (an SVG) may follow and be replaced once reviewed.
export type ExplainTurn = { question: string; text: string };
type ExplainBase = { sessionId: string; thread: string; index: number };
export type ExplainEvent =
  | (ExplainBase & { type: 'explain-answer'; text: string })
  | (ExplainBase & { type: 'explain-drawing'; svg: string })
  | (ExplainBase & { type: 'explain-error'; error: string });

// A spoken recap of one reply (reply is its item id); url is null until ready, 'dropped' means failed, superseded or evicted.
export type VoiceState = 'preparing' | 'ready' | 'dropped';
export type VoiceClip = { type: 'voice'; sessionId: string; id: string; reply: string; state: VoiceState; url: string | null; text: string; words: number };
// A spoken summary of a whole replay (id is its tool call id). step names the running part while preparing; 'dropped' means evicted.
export type ReplayVoice = {
  type: 'replay-voice'; sessionId: string; id: string; state: 'preparing' | 'ready' | 'failed' | 'dropped';
  step: 'script' | 'audio' | null; url: string | null; text: string; words: number; error: string | null;
};

// Voice input (hold Space). Hold states, text and errors reach only the client holding; engine states reach every client.
// take is the client's take id: a message with it is about that take, one without it is an engine state.
// Every take ends with exactly one message carrying text, error or cancelled.
export type SttState = 'idle' | 'starting' | 'ready' | 'recording' | 'transcribing' | 'unavailable';
export type SttMessage = { type: 'stt'; state: SttState; take?: number; text?: string; error?: string; cancelled?: true };

// The CLI's AskUserQuestion input, trimmed to what the card shows.
export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string; preview?: string }[] };
// answers is keyed by question text; mode is the mode an approved plan runs in; feedback sends a plan back.
export type AskReply = { answers?: Record<string, string>; mode?: Mode; feedback?: string };

// A replay manifest, loaded on demand; page urls are served read-only from the manifest's folder.
export type ReplayPage = { id: string; title: string; url: string; width: number; height: number };
export type ReplayInfo = { title: string; pages: ReplayPage[]; error: string | null };

export type ClientMessage =
  | { type: 'hello'; sessionId: string | null; afterSeq: number; serverId?: string }
  // id becomes the message's id, so the client can match the echo to what it shows as sending.
  // style starts the CLI with that reply style; seen becomes a note to the model on this turn.
  | { type: 'send'; sessionId: string; text: string; pastes?: string[]; files?: Upload[]; thumbs?: (string | null)[]; id?: string; style?: ReplyStyle; seen?: StretchSeen }
  | { type: 'permission-answer'; sessionId: string; id: string; allow: boolean; reply?: AskReply }
  | { type: 'interrupt'; sessionId: string }
  // Restarts the session's CLI so new instructions, settings and skills apply; the transcript stays.
  | { type: 'reload'; sessionId: string; style?: ReplyStyle }
  // Runs the context handoff now, past the automatic retry limit; refused while the session works.
  | { type: 'handoff'; sessionId: string }
  // Turns Remote Control on or off; a refusal comes back as a notice.
  | { type: 'remote-control'; sessionId: string; on: boolean }
  | { type: 'list-past' }
  | { type: 'find-dirs'; query: string }
  | ({ type: 'open'; cwd: string } & Settings)
  | { type: 'resume'; id: string }
  | { type: 'set-mode'; sessionId: string; mode: Mode }
  // keys name files in ~/.claude/mcp; servers maps other server names to on/off. mcp-status asks for the menu with fresh states.
  | { type: 'set-mcp'; sessionId: string; keys: string[]; servers?: Record<string, boolean> }
  | { type: 'mcp-status'; sessionId: string }
  // Starts a server's sign-in, or reconnects it once the user signed in elsewhere.
  | { type: 'mcp-auth' | 'mcp-reconnect'; sessionId: string; server: string }
  | { type: 'set-model'; sessionId: string; model: string; effort: Effort }
  // Close stops the live query; the transcript stays.
  | { type: 'close'; sessionId: string }
  | { type: 'rename'; id: string; title: string }
  | { type: 'archive'; id: string; archived: boolean }
  | { type: 'delete'; id: string }
  | { type: 'list-dirs'; path: string }
  | { type: 'stop-task'; sessionId: string; taskId: string }
  | { type: 'agent-message'; sessionId: string; agentId: string; text: string }
  // Streams one process log to this client; null stops it.
  | { type: 'watch-log'; sessionId: string; taskId: string | null }
  | { type: 'dismiss'; sessionId: string; id: string }
  // The sheet opened: old chapters may get Haiku titles now.
  | { type: 'map-open'; sessionId: string }
  // id is the ask_choice tool_use id; index is the picked option, text an answer typed instead.
  | { type: 'choice-answer'; sessionId: string; id: string; index?: number; text?: string }
  // id is the ask_round tool_use id; one answer per question, in order.
  | { type: 'round-answer'; sessionId: string; id: string; answers: RoundPick[] }
  // Takes a queued message back before Claude reads it; now sends it again as an interrupting message.
  | { type: 'unqueue'; sessionId: string; id: string; then: 'remove' | 'now' }
  | { type: 'replay-load'; sessionId: string; id: string }
  | { type: 'changes-load'; sessionId: string; id: string; path: string }
  | { type: 'agent-load'; sessionId: string; id: string }
  // Watch mode's timeline: the newest page without before, then older pages with the reply's before.
  | { type: 'watch-load'; sessionId: string; before?: number }
  // Events older than seq before, about a page, starting at a prompt; until (a seq) or id (an event id) stretches the page back to include it.
  // Seqs of a resumed session's history before its last compaction are 0 or below.
  | { type: 'history-load'; sessionId: string; before: number; until?: number; id?: string }
  // Searches every event of the session, loaded by this client or not.
  | { type: 'history-find'; sessionId: string; query: string }
  // The user started typing: the server starts that session's CLI so the first reply skips its boot.
  | { type: 'warm'; sessionId: string; style?: ReplyStyle }
  | { type: 'tree-list' | 'tree-read'; sessionId: string; path: string }
  | { type: 'voice-set'; on: boolean }
  // Voice input: warm boots the engine on composer intent; start and stop follow the Space hold, cancel drops a take.
  | { type: 'stt-warm' }
  | { type: 'stt-start' | 'stt-stop' | 'stt-cancel'; take: number }
  // The Listen button: reply is the agent item id, text its raw reply and prompt the request that led to it.
  | { type: 'voice-recap'; sessionId: string; reply: string; prompt: string; text: string }
  // The replay viewer's Listen button: one spoken summary of the whole replay, made once and cached.
  | { type: 'replay-voice'; sessionId: string; id: string }
  | { type: 'connect-check' }
  | { type: 'login-start' | 'login-cancel' | 'logout' }
  // The code the sign-in page shows, written to the waiting CLI's stdin.
  | { type: 'login-code'; code: string }
  | { type: 'settings-load' }
  | { type: 'settings-set'; id: string; patch: SettingsPatch }
  // update-check asks GitHub now; update installs that release tag and restarts the app.
  | { type: 'update-check' }
  | { type: 'update'; tag: string }
  // thread groups one panel's follow-ups; turns is what the panel already shows.
  // deep: answer from a fork of the whole conversation with the session's model instead of the recent messages with Sonnet.
  | { type: 'explain'; sessionId: string; thread: string; excerpt: string; turns: ExplainTurn[]; question: string; deep?: boolean }
  // A click in the plugin band; key names the element, path finds a keyless one; href is a clicked link.
  | { type: 'ui-press'; sessionId: string; plugin: string; key: string | null; path: number[]; href?: string }
  | { type: 'ui-prompt-answer'; sessionId: string; id: string; answer: UiPromptAnswer };
