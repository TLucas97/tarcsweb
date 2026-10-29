// Wire protocol shared by the server and the web client (JSON over one WebSocket at /ws).

// Bump when a change would make an older open page misread the server (removed or reshaped fields); additive fields need no bump.
export const PROTOCOL_VERSION = 1;

export type Status = 'working' | 'idle';
// What the dock shows per session; 'done' means a turn ended while nobody was watching.
export type DockState = 'working' | 'waiting' | 'idle' | 'done';
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
// ultra is Codex only; Claude's menus and validation use EFFORTS.
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CODEX_EFFORTS: Effort[] = [...EFFORTS, 'ultra'];
export type ClaudeEffort = Exclude<Effort, 'ultra'>;
export const claudeEffort = (e: Effort): ClaudeEffort => (e === 'ultra' ? 'max' : e);
export const MODEL_IDS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
// A Codex model slug from model/list ("gpt-6-astra"); the catalog decides which ones exist.
export const CODEX_MODEL = /^(?!claude-)[a-z0-9][a-z0-9._-]{1,63}$/i;

// Which agent runs a tab's main thread; fixed once the tab has a message.
export type Provider = 'claude' | 'codex';
export const providerOf = (model: string): Provider => (MODEL_IDS.includes(model) || model.startsWith('claude-') ? 'claude' : 'codex');
// What the client may offer on a tab; Codex lacks the Claude Code features below.
// branch: "Branch from here"; the Codex wrapper can only fork a whole thread, not up to a turn.
export type Caps = { remote: boolean; mcpMenu: boolean; slash: boolean; voiceInput: boolean; handoff: boolean; deepExplain: boolean; branch: boolean };
export const PROVIDER_CAPS: Record<Provider, Caps> = {
  claude: { remote: true, mcpMenu: true, slash: true, voiceInput: true, handoff: true, deepExplain: true, branch: true },
  codex: { remote: false, mcpMenu: false, slash: false, voiceInput: false, handoff: false, deepExplain: false, branch: false },
};

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
// Codex, the second provider: installed and version come from `codex --version`, the rest from the app-server's account/read.
// resetsAt is in ms. email and plan are for the local user's eyes only, never logged.
export type CodexLimitWindow = { usedPercent: number; windowMins: number | null; resetsAt: number | null };
export type CodexStatus = {
  installed: boolean; version: string | null; versionOk: boolean; testedVersion: string;
  signedIn: boolean; method: 'chatgpt' | 'apiKey' | null; email: string | null; plan: string | null;
  limits: { primary: CodexLimitWindow | null; secondary: CodexLimitWindow | null } | null;
  error: string | null; checkedAt: number;
};
// browser gets a page whose callback lands on this machine; device gets a page and a one-time code, for remote machines.
export type CodexLoginFlow = 'browser' | 'device';
export type CodexLoginState = { state: 'idle' | 'starting' | 'waiting' | 'signing-out'; flow: CodexLoginFlow | null; url: string | null; code: string | null; error: string | null };
export type CodexModel = {
  id: string; model: string; name: string; description: string; isDefault: boolean;
  efforts: string[]; defaultEffort: string; multiAgent: 'v1' | 'v2' | null; images: boolean;
};
// A new tab on Codex: the catalog default, keeping the effort when that model has it.
export function codexDefault(models: CodexModel[], s: Settings): Settings | null {
  const m = models.find((x) => x.isDefault) ?? models[0];
  if (!m) return null;
  const efforts = CODEX_EFFORTS.filter((e) => m.efforts.includes(e));
  const effort = efforts.includes(s.effort) ? s.effort : efforts.includes(m.defaultEffort as Effort) ? (m.defaultEffort as Effort) : (efforts[0] ?? 'medium');
  return { mode: s.mode, model: m.id, effort };
}
export type ConfigLanguage = 'en' | 'pt-BR';
// Lite trims background work and visual extras for slower machines.
export const PERF_PROFILES = ['standard', 'lite'] as const;
export type PerfProfile = (typeof PERF_PROFILES)[number];
// What the server knows about the machine it runs on; the client scores it to decide whether to suggest Lite. Missing values are null.
export type MachineFacts = {
  totalMemory: number; constrainedMemory: number | null; freeMemory: number | null; cpus: number; cpuModel: string | null;
  platform: string; arch: string; wsl: boolean; rosetta: boolean;
};
// The editable part of the config file; the ntfy topic is shown to the local user only.
// handoffAt is the threshold in effect, null when off. perf is the saved choice, null when never chosen; perfForced means CW_PROFILE overrides it.
export type SettingsView = {
  language: ConfigLanguage; ntfy: { topic: string; server: string } | null; handoffAt: number | null; youShouldKnow: boolean;
  perf: PerfProfile | null; perfForced: boolean; path: string;
  // What a new session starts with; absent from older servers.
  defaults?: Settings;
};
// Only the keys being changed; ntfy true makes a random topic, false clears it. handoffAt false turns it off.
// defaults never takes Bypass: a new session must not start without asking.
export type SettingsPatch = { language?: ConfigLanguage; ntfy?: boolean; handoffAt?: number | false; youShouldKnow?: boolean; perf?: PerfProfile; browserAgents?: boolean; defaults?: Settings };

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
// A non-choice question takes one typed value (in RoundPick.note) and has no options; saved rounds without kind are choice.
export type RoundKind = 'choice' | 'text' | 'number' | 'path';
// recommended is an option index (never preselected); suggested is a typed question's answer (never prefilled); why explains either.
export type RoundQuestion = {
  title: string; setup: string; options: { label: string; description: string }[]; recommended: number | null; why: string; kind?: RoundKind; placeholder?: string; suggested?: string;
};
export type RoundSpec = { title: string; questions: RoundQuestion[] };
// One ask_round answer: a picked option, a note, both, or neither (unanswered).
export type RoundPick = { option: number | null; note: string };
// ask_round's error when the round was cancelled; any other error is a rejected call the card shows.
export const ROUND_CANCELLED = 'The user did not answer.';
// What the user sent from an ask_prototype card: named controls merged with window.proto.set values; dropped keys did not fit the cap.
// variant: the label of the variant picked; comments: notes the user pinned to elements of the page.
export type ProtoAnswer = { values: Record<string, unknown>; note: string; dropped?: string[]; variant?: string; comments?: ProtoComment[] };
// on: what the element reads as (`<button.primary> "Apply"`); selector finds it again in the page.
export type ProtoComment = { variant?: string; on: string; selector: string; text: string };
export const PROTO_COMMENTS_MAX = 30;
// Field lengths the server accepts; the card keeps under them, since a refused answer never reaches the model.
export const PROTO_COMMENT_LEN = { on: 300, selector: 4000, text: 2000 };
export const PROTO_VARIANTS_MAX = 4;
// ask_checklist: items the user may tick; recommended ones are marked, never pre-ticked.
export type ChecklistSpec = { title: string; items: { label: string; note: string; recommended: boolean }[] };
// What an ask_checklist card sent: ticked item indexes, ascending; no ticks and no note means "reply in chat".
export type ChecklistAnswer = { ticked: number[]; note: string };
export const CHECKLIST_MAX = 20;
export type RichDetail =
  | { kind: 'visual'; html: string; width: number; height: number; durationMs: number; title: string; interactive: boolean }
  // ask_prototype: a live page the user tunes, sized like render_ui; question says what to tune or pick.
  // variants replace html with 2-4 pages shown side by side; placeholders names what will not ship as drawn.
  | { kind: 'prototype'; html: string; width: number; height: number; title: string; question: string; variants?: { label: string; html: string }[]; placeholders?: string }
  | { kind: 'replay'; title: string; page: number }
  | { kind: 'chart'; chart: ChartSpec }
  | { kind: 'table'; table: TableSpec }
  | { kind: 'plan'; plan: PlanSpec }
  | { kind: 'choice'; choice: ChoiceSpec }
  | { kind: 'round'; round: RoundSpec }
  | { kind: 'checklist'; checklist: ChecklistSpec }
  | { kind: 'image'; prompt: string; count: number }
  // show_image: the picture itself comes signed in the result's images.
  | { kind: 'picture'; path: string; caption: string }
  // ask_upload: accept holds normalized patterns (see acceptsFile).
  | { kind: 'upload'; prompt: string; accept: string[] };
export type ToolDetail = DiffDetail | RichDetail;
// A picture generate_image saved: src is its signed URL, path where it lives on disk.
export type GenImage = { src: string; path: string };
// A file the user gave ask_upload, saved at path; src is a signed URL for pictures only.
export type AskedFile = { path: string; name: string; bytes: number; src?: string };
export const ASK_UPLOAD_MAX = 10;
// ask_upload's accept: ".png" matches the name, "image/*" a MIME family, anything else one MIME type; empty takes any file.
export function acceptsFile(accept: string[], name: string, mime: string) {
  if (!accept.length) return true;
  const n = name.toLowerCase();
  const m = mime.toLowerCase();
  return accept.some((p) => (p.startsWith('.') ? n.endsWith(p) : p.endsWith('/*') ? m.startsWith(p.slice(0, -1)) : m === p));
}
// One agent's file changes in one user turn; owner is its agents panel row id. The full diff loads with changes-load.
export type ChangeFile = { path: string; add: number; rm: number; created: boolean; note?: string };
// kind: 'revert' holds reverts and their undos, 'shell' files git saw change with no file tool behind them.
export type ChangeCard = { id: string; turn: string; owner: string; main: boolean; name: string; files: ChangeFile[]; add: number; rm: number; more: number; kind?: 'revert' | 'shell' };
// a and b are the hunk's first line numbers before and after; note says why a file has no diff.
// lines: the old side's line count (for the last collapsed gap); revertable: a saved copy exists to go back to.
export type FileDiff = {
  path: string; add: number; rm: number; created: boolean; note: string | null; hunks: { a: number; b: number; lines: DiffLine[] }[]; truncated: boolean;
  lines?: number; revertable?: boolean;
};
// Net lines per file over the whole session; shell: only git saw it change, so the counts are against HEAD.
export type ChangeIndexFile = { path: string; add: number; rm: number; created?: boolean; shell?: true };

// A file sent with a prompt: images and PDFs go to the model as blocks, text files as text.
export type FileKind = 'image' | 'pdf' | 'text';
export type Upload = { name: string; kind: FileKind; mime: string; data: string };
// What the conversation shows for a sent file; thumb and src are signed URLs of the small and full picture.
export type Attachment = { name: string; kind: FileKind; thumb?: string; src?: string };
// A span of the prompt text [start, end) tied to an attachment; at counts files first, then pastes, from 0.
export type TextLink = { start: number; end: number; at: number };
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Why the server refuses a sent file, or null. Images and PDFs arrive as base64, text files as their text (may be empty).
// The client runs it too, so a card can say why before sending.
export function uploadProblem(f: unknown): string | null {
  if (!f || typeof f !== 'object') return 'A file could not be read';
  const u = f as Record<string, unknown>;
  if (typeof u.name !== 'string' || !u.name || u.name.length > 300) return 'A file name is empty or too long';
  const { data } = u;
  if (typeof data !== 'string') return `${u.name} could not be read`;
  const max = u.kind === 'image' ? 7_000_000 : u.kind === 'pdf' ? 30_000_000 : 2_000_000;
  const typed = u.kind === 'image' ? IMAGE_MIMES.includes(u.mime as string) : u.kind === 'pdf' ? u.mime === 'application/pdf' : u.kind === 'text' && typeof u.mime === 'string';
  if (!typed) return `${u.name} is not a supported file type`;
  if (!data && u.kind !== 'text') return `${u.name} is empty`;
  return data.length > max ? `${u.name} is too large` : null;
}
// Longest side of the server thumbnail a signed image URL serves with ?w=THUMB_SIDE.
export const THUMB_SIDE = 640;

export type ServerEvent =
  // pastes: long pasted blocks sent with the prompt, shown as chips.
  // queued: sent while Claude works; it waits until the CLI picks it up ('delivered').
  // stopped: interrupted before Claude answered it. phone: sent through Remote Control (Claude app or claude.ai).
  | { type: 'user'; id: string; text: string; pastes?: string[]; files?: Attachment[]; links?: TextLink[]; queued?: boolean; stopped?: boolean; phone?: boolean }
  | { type: 'delivered'; id: string }
  | { type: 'unqueued'; id: string }
  | { type: 'text'; id: string; delta: string }
  // verb is the row label ("read", "edit", "run"); partial calls are still streaming their input; fold hides
  // this call inside the rich item with that id (a Read of a render_ui picture).
  // desc: the plain-words description the agent gave a Bash call.
  | { type: 'tool'; id: string; name: string; verb: string; summary: string; desc?: string; detail?: ToolDetail; partial?: boolean; fold?: string; replaces?: string }
  // choice is the picked option index for ask_choice (old transcripts only; null when nobody answered); png is a render_ui picture.
  // round holds ask_round's answers in question order (null when the round was cancelled); proto and checklist are ask_prototype's and ask_checklist's, the same way.
  // images and ms: generate_image's saved pictures and how long it took, or show_image's one picture. brief: a failed command's telling output line.
  // video: the recording browser_record saved. uploads: the files the user gave ask_upload. pagePngs: a replay's rendered pages, by page id.
  | {
      type: 'tool-result'; id: string; error: string | null; choice?: number | null; answer?: string; round?: RoundPick[] | null; roundExtra?: string; proto?: ProtoAnswer | null; checklist?: ChecklistAnswer | null; png?: string; img?: string;
      images?: GenImage[]; ms?: number; brief?: string; video?: BrowserVideo; uploads?: AskedFile[]; pagePngs?: ReplayPng[];
    }
  // id is the tool_use id, so the card replaces that tool's line.
  // questions: an AskUserQuestion call; plan: an ExitPlanMode call waiting for approval, back the mode it returns to by default.
  // always: the card also offers allowing it for the rest of the asking agent's session (Codex approvals).
  // command: a Bash call's whole command (capped at 20k), when the one-line summary cuts or flattens it.
  | { type: 'permission'; id: string; tool: string; summary: string; command?: string; title?: string; defaultToNo?: boolean; detail?: DiffDetail; questions?: Question[]; plan?: string; back?: Mode; always?: true }
  // elsewhere: answered on the phone through Remote Control first, so allow says nothing.
  // cancelled: the asker stopped waiting (a Codex agent stopped, or Codex settled the request itself).
  | { type: 'permission-resolved'; id: string; allow: boolean; reply?: AskReply; elsewhere?: boolean; cancelled?: true }
  | { type: 'turn-end'; ok: boolean; subtype: string }
  | { type: 'status'; state: Status }
  | { type: 'error'; message: string }
  // Haiku's short summary of a long answer; id is that answer's text item.
  | { type: 'tldr'; id: string; text: string; words: number }
  // A plain explanation of a failed Bash call; id is the tool_use id.
  | { type: 'tool-note'; id: string; text: string }
  // Sent again with the same id each time that agent's changes grow.
  | ({ type: 'changes' } & ChangeCard)
  // A turn the agent started on its own, sent before its first row; from: what woke it, oldest first (empty when unknown).
  | { type: 'wake'; id: string; from: Wake[] }
  // A turn an agent's report started ended with no real reply; hide: its placeholder text rows, which this notice replaces.
  | { type: 'quiet'; id: string; hide?: string[] };

// What woke the agent: a finished agent, a background command, a monitor event, or another notification (via null).
export type Wake = { via: 'agent' | 'command' | 'monitor' | null; name: string };

// at: epoch ms when the server emitted it, or the transcript time in resumed history. Later chunks of a text block omit it.
export type TimedEvent = ServerEvent & { at?: number };
export type SeqEvent = TimedEvent & { seq: number; sessionId: string };

// A row holding search matches: id is the event id the client keys the row by, seq where it sits (for history-load), n the matches in it.
export type FindHit = { id: string; seq: number; n: number };

// Watch mode's compact timeline of the whole transcript, loaded with watch-load. No text, diffs or images.
// s: the file path for file tools, else a one-line summary; end: when the call's result came; turn-end ids are synthetic.
// desc: a Bash call's own description; why: the telling output line of a failed command.
// text: s is the first sentence, goal a reply's "Objective:" line. note (subagents only): a progress step s, d done of n.
// out, exit (Codex agents' commands only): the output's last lines and the exit code.
export type WatchKind = 'user' | 'text' | 'tool' | 'plan' | 'agent' | 'permission' | 'error' | 'turn-end' | 'note';
export type WatchEntry = {
  k: WatchKind; id: string; at: number | null; end?: number;
  verb?: string; s?: string; desc?: string; why?: string; add?: number; rm?: number; created?: true; err?: true;
  plan?: PlanSpec; state?: AgentState; goal?: string; d?: number; n?: number; out?: string; exit?: number;
};
// A subagent's own transcript, keyed by its spawning Agent tool_use id. rev is the watch-subs cursor; more counts the
// actions dropped before entries (the server keeps the newest few hundred). Entries are all kept, or only those changed since the cursor.
export type WatchSub = { aid: string; rev: number; more: number; entries: WatchEntry[] };
// page echoes the request's before; before is the cursor for the next older page, null once this page reaches the start.
// subs: the transcripts of the agents this page spawned.
export type WatchPage = { entries: WatchEntry[]; page: number | null; before: number | null; error?: string; subs?: WatchSub[] };

// What a check command checks, read from its command line; null for other commands.
export type CheckKind = 'types' | 'tests' | 'build' | 'lint';
const CHECK_LEAD = /^(?:\w+=\S*\s+)*(?:(?:timeout\s+\S+|time|npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|uv\s+run|poetry\s+run)\s+)*/;
const CHECKS: [CheckKind, RegExp][] = [
  ['tests', /^(?:vitest|jest|mocha|pytest|rspec|phpunit|playwright\s+test|cargo\s+(?:test|nextest)|go\s+test|deno\s+test|bun\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)\b/],
  ['types', /^(?:tsc|vue-tsc|mypy|pyright|cargo\s+check|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|tsc))\b/],
  ['lint', /^(?:eslint|biome\s+(?:check|lint)|ruff|cargo\s+clippy|prettier\s+--check|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint)\b/],
  ['build', /^(?:vite\s+build|next\s+build|cargo\s+build|go\s+build|tsup|webpack|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build)\b/],
];
export function checkOf(cmd: string): CheckKind | null {
  for (const part of cmd.split(/&&|\|\||[;|]/)) {
    const seg = part.trim().replace(CHECK_LEAD, '');
    for (const [kind, re] of CHECKS) if (re.test(seg)) return kind;
  }
  return null;
}

// Narration as watch shows it: the first sentence of a text, without markdown marks; stretchtext keeps its short form.
// Headings and the objective line are skipped when a sentence follows. whole: a streaming text has finished it.
const MD_LEAD = /^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)+/;
const GOAL_LINE = /^(?:\*\*|__)?(?:Objetivo|Objective|Goal)(?:\*\*|__)?\s*:/i;
const plainOf = (s: string) => s.replace(/\{\{([^|}]*)\|[^}]*\}\}/g, '$1').replace(/\*\*|__|`/g, '');
export function firstSentence(text: string, max = 140) {
  const raw = text.slice(0, 4000).split('\n');
  let pick = -1, first = -1;
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i].trim();
    if (!l || l.startsWith('```') || l.startsWith('|')) continue;
    if (first < 0) first = i;
    if (!l.startsWith('#') && !GOAL_LINE.test(l)) {
      pick = i;
      break;
    }
  }
  if (pick < 0) pick = first;
  if (pick < 0) return { s: '', whole: false };
  const flat = plainOf(raw[pick].trim().replace(MD_LEAD, '')).replace(/\s+/g, ' ').trim();
  const m = /[.!?…](?=\s)/.exec(flat) ?? /[.!?…]$/.exec(flat);
  const s = m ? flat.slice(0, m.index + 1) : flat;
  return { s: s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s, whole: pick < raw.length - 1 || (!!m && m.index + 1 < flat.length) };
}
// A reply's "Objective: …" line (also Objetivo/Goal, maybe bold) near its start, so a streaming reply is scanned only
// that far; whole says the answer is final (the line ended, or the head passed without one).
const GOAL = /^[ \t]*(?:\*\*|__)?(?:Objetivo|Objective|Goal)(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?(.+)$/im;
const GOAL_HEAD = 600;
export function goalOf(text: string, max = 160) {
  const head = text.slice(0, GOAL_HEAD);
  const m = GOAL.exec(head);
  if (!m) return { goal: '', whole: text.length > GOAL_HEAD };
  const goal = plainOf(m[1]).replace(/\s+/g, ' ').trim();
  return { goal: goal.length > max ? goal.slice(0, max - 1).trimEnd() + '…' : goal, whole: m.index + m[0].length < head.length };
}

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
  // Context fill of the newest model call, out of window.
  tokens: number | null;
  window: number | null;
  // Run totals: tokens used across every call and the run's duration, when the SDK reports them.
  used?: number;
  durationMs?: number;
  steps: Steps | null;
  // Step names reported through the progress tool for the current task, oldest first; last = current.
  stepLog: string[];
  now: string;
  // The model's progress summary, sent only when `now` shows a progress step instead.
  summary?: string;
  // Newest first and capped; filesMore counts the older ones left out. Empty for main.
  files: FileTouch[];
  filesMore?: number;
  // The last line it wrote; the full text, task and report load with agent-load.
  said: string;
  // Bumps whenever the long text changes, so an open detail knows to load it again.
  rev: number;
  // Messages sent to it after spawn (SendMessage): how many, and the newest as one line.
  followUpCount: number;
  lastFollowUp: string | null;
  canStop: boolean;
  // 'codex' rows are Codex threads the main agent started; canMessage: the panel can send it a message.
  // 'workflow' rows are Workflow runs; agents counts the agents the run started.
  kind: 'claude' | 'codex' | 'workflow';
  canMessage: boolean;
  // Why a failed row failed, one line.
  error?: string;
  // Last message, tool result, stream delta or task event (rounded to 5 s), tool calls so far, and whether the last call is a shell command.
  lastAt?: number;
  toolUses?: number;
  shell?: true;
  agents?: number;
  // Agents inside a workflow run: parent is the run's row id, phase the script phase they ran in.
  parent?: string;
  phase?: string;
};
export type ProcState = 'running' | 'done' | 'failed' | 'stopped';
// exit is read from the notification summary text; the SDK has no numeric exit code field.
// label: the Bash tool's short description, when the call had one. tool: the Bash call's id, so its row in the conversation can follow the job.
export type ProcRow = { id: string; command: string; label: string | null; state: ProcState; startedAt: number; endedAt: number | null; summary: string | null; exit: number | null; tool?: string };
export type Panel = { active: boolean; agents: AgentRow[]; procs: ProcRow[] };
// On the wire: full on subscribe, then only changed rows; an order lists every row id and comes only when the ids changed.
export type PanelPatch = { active: boolean; full: boolean; agents: AgentRow[]; procs: ProcRow[]; agentOrder?: string[]; procOrder?: string[] };
// A row's long text: the prompt a subagent got, its output so far (last 6 KB), its report ('' and null for main) and follow-ups.
export type AgentText = { rev: number; task: string; text: string; result: string | null; followUps: { at: number; text: string }[] };
// live: the CLI's own tail of the output; file: the output_file the SDK named; redirect: a file the command
// itself writes to (`> f`, `tee f`); summary: none was readable.
export type LogSource = 'live' | 'file' | 'redirect' | 'summary';
// One place a process writes to; key is 'live', 'file', 'summary' or the file path.
export type LogSourceInfo = { key: string; kind: LogSource; label: string; path?: string; bytes: number };

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
// force-stop targets the session; agent targets an agents panel row id.
export type HeadsUpAction = { kind: 'review' | 'log' | 'switch' | 'force-stop' | 'agent'; target: string };
// A plain permission waiting in another session, answerable from this one.
export type PeerAsk = { sessionId: string; id: string; tool: string; summary: string; command?: string; title?: string; detail?: DiffDetail };
export type HeadsUp = { id: string; need: boolean; text: string; detail: string; action: HeadsUpAction | null; dismissable: boolean; ask?: PeerAsk };
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
  // A provider switch: the provider the new tab runs on, and that tab once it is open (held messages went there).
  to?: Provider;
  tab?: string | null;
};
// The hand-over message starts with this; old transcripts show it as a card too. A compaction summary starts with the other.
export const HANDOFF_PREFIX = 'The conversation was just compacted. A handoff document written right before it is at ';
export const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';
// The first message of a tab opened by a provider switch.
export const SWITCH_PREFIX = 'This conversation moved here from another agent. A handoff document written right before the switch is at ';
// The chapter and timeline label for a note message, or null for an ordinary prompt.
export const noteLabel = (text: string) =>
  text.startsWith(HANDOFF_PREFIX) ? 'Context handoff' : text.startsWith(SWITCH_PREFIX) ? 'Provider handoff' : text.startsWith(SUMMARY_PREFIX) ? 'Compaction summary' : null;
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
// A skill in the main agent's context: loaded with the Skill tool, a typed /command, or a library chip (a plain read).
// kept: a compaction re-attached it, maybe shortened; lost: a compaction dropped it (chips only).
export type ActiveSkill = { name: string; how: 'tool' | 'slash' | 'chip'; desc?: string; path?: string; kept?: true; lost?: true };
// above: plugins' band above the prompt (null when none draws).
export type SessionMap = {
  chapters: Chapter[]; now: string; need: boolean; headsUps: HeadsUp[]; usage: SessionUsage; handoff: HandoffState | null; toasts: Toast[]; above: UiNode | null;
  skills: ActiveSkill[];
};
// Not full: chapters holds only changed rows, and chapterOrder comes when the id list changed.
export type MapPatch = SessionMap & { full: boolean; chapterOrder?: string[] };
export type LimitKey = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';
// pct is 0-100; resetsAt is epoch ms.
export type LimitWindow = { pct: number | null; resetsAt: number | null };
export type Limits = { windows: Partial<Record<LimitKey, LimitWindow>>; status: 'allowed' | 'allowed_warning' | 'rejected'; type: string | null; resetsAt: number | null };

export type SessionSummary = Settings & {
  id: string;
  name: string;
  // The name in English, which the notification voice reads instead.
  spoken?: string;
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
  // Work a server restart cut off; absent otherwise.
  interrupted?: true;
  provider: Provider;
  caps: Caps;
  // No message sent yet, so picking a model of the other provider switches the tab.
  fresh: boolean;
  // Lineage, by transcript id: the conversation this tab was branched from, and the branches made from this one.
  parent?: BranchLink;
  branches?: BranchLink[];
  // The worktree tarcsweb made for this branch; deleting the tab can remove it.
  worktree?: string;
};

export type BranchLink = { id: string; name: string };

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
  active?: boolean;
  state?: McpPack['state'] | 'disabled'; error?: string; tools?: number; pending?: true;
  // Why a pack cannot run now (it stays locked until that changes).
  needs?: string;
};
// What the session's Claude Code is doing about MCP: booting, restarting for a change, or waiting for the turn to end first.
export type McpPhase = 'starting' | 'restarting' | 'waiting';
// A sign-in answer: url opens in a browser tab; manual means the app must reconnect once the user is back (claude.ai connectors).
export type McpAuthReply = { url?: string; manual?: true; checked?: true; error?: string };

// A Codex row's id is its thread id.
export type PastSession = { id: string; name: string; cwd: string; branch: string | null; lastModified: number; archived: boolean; provider: Provider };
// A saved conversation whose text matches a palette search; snippet wraps each match in \u0002 and \u0003.
export type SearchHit = PastSession & { source: string; snippet: string };
// A session the AI search picked; why says in a few words what fits the question.
export type AiHit = SearchHit & { why: string };
export type Folder = { path: string; branch: string | null; hasChildren: boolean };
export type Dir = Folder & { name: string };
// Sessions tagged with this are hidden from the palette's normal list.
export const ARCHIVED_TAG = 'archived';

// A permission ask from a claude session in a terminal, held until answered there, here, or timed out. always: the
// terminal offered "don't ask again" rules, so Always can apply them.
export type TerminalAsk = { id: string; tool: string; summary: string; command?: string; title?: string; detail?: DiffDetail; always: boolean; at: number };
// A claude session running outside the app, known through its hooks. id is its transcript id; name is null until known.
export type TerminalSession = { id: string; cwd: string; name: string | null; state: DockState; lastActive: number; asks: TerminalAsk[] };
// The hooks in Claude Code's user settings: partial means some of them are missing; error says the file cannot be read.
export type TerminalHooksView = { installed: boolean; partial: boolean; path: string; error: string | null };
// The file manager's right-click items. platform is null when this desktop is not supported; entries are the exact files
// and registry keys the switch creates and removes; note is a platform caveat; error says the state cannot be read.
export type FolderMenuPlatform = 'kde' | 'gnome' | 'wsl' | 'mac';
export type FolderMenuView = {
  platform: FolderMenuPlatform | null; where: string; installed: boolean; partial: boolean; entries: string[]; note: string | null; error: string | null;
};

export type ServerMessage =
  | SeqEvent
  // The backlog after a hello, applied in one render. replace: drop what is held and start from these (the log's newest
  // part); older is then the history-load cursor, null at the start. status is the session's state now, which a
  // status event trimmed off the in-memory log can no longer tell.
  | { type: 'events'; sessionId: string; events: SeqEvent[]; replace?: true; older?: number | null; status?: Status }
  // A peeked session's light stream (session widgets); replace starts it over from a short tail.
  | { type: 'peek-events'; sessionId: string; events: SeqEvent[]; replace?: true }
  // Answer to history-load, oldest first; before echoes the request, older is the cursor for the next page.
  | { type: 'history'; sessionId: string; before: number; events: SeqEvent[]; older: number | null; error?: string }
  // Answer to history-find over the whole session, oldest first; more: the match cap cut the list.
  | { type: 'history-found'; sessionId: string; query: string; hits: FindHit[]; more: boolean; error?: string }
  // Reply to a subscribe, sent before the replay. A new serverId means every log restarted.
  // defaults: the settings a new session starts with, from the user's config. protocol: the server's PROTOCOL_VERSION.
  | { type: 'hello'; serverId: string; reset: boolean; sessionId: string | null; found: boolean; defaults: Settings; browserKey: string; protocol?: number }
  | { type: 'sessions'; open: SessionSummary[] }
  // Sessions in a terminal, sent on connect and to every client on each change.
  | { type: 'terminal'; sessions: TerminalSession[] }
  // Answer to terminal-hooks-load, or to terminal-hooks-set with its req; backup is the copy made before writing.
  | { type: 'terminal-hooks'; hooks: TerminalHooksView; reply?: { req: string; error: string | null; backup: string | null } }
  // What terminal-hooks-set would write; base names the file read, so the write refuses a file changed since.
  | { type: 'terminal-hooks-preview'; on: boolean; diff: DiffDetail | null; base: string; error: string | null }
  // Answer to folder-menu-load, or to folder-menu-set with its req.
  | { type: 'folder-menu'; menu: FolderMenuView; reply?: { req: string; error: string | null } }
  // A folder picked in the file manager's right-click menu: resume names the session to continue, null opens a new one.
  | { type: 'open-folder'; cwd: string; resume: string | null }
  | { type: 'past'; sessions: PastSession[]; folders: Folder[]; home: string }
  // widget: resumed for a session widget, so the client keeps the session it shows.
  | { type: 'opened'; sessionId: string; widget?: true }
  | { type: 'dirs'; path: string; branch: string | null; dirs: Dir[] }
  | { type: 'dirs'; path: string; error: string }
  | { type: 'found'; query: string; dirs: Dir[] }
  // indexing: the first index build has not finished, so hits may be missing.
  | { type: 'search-found'; query: string; cwd: string | null; hits: SearchHit[]; indexing: boolean }
  // Answer to search-ai, best pick first; a superseded request gets no answer.
  | { type: 'search-ai-found'; query: string; cwd: string | null; hits: AiHit[]; error?: string }
  // No tone means an error. unsent: the id of a send whose session is gone; that outbox row fails instead.
  | { type: 'notice'; message: string; tone?: 'info'; unsent?: string }
  // The server is quitting on purpose (tray Quit), so the page closes instead of reconnecting.
  | { type: 'bye' }
  | { type: 'pong' }
  | ({ type: 'panel'; sessionId: string } & PanelPatch)
  // null when that row is gone from the panel.
  | { type: 'agent-detail'; sessionId: string; id: string; detail: AgentText | null }
  // Answer to tool-output-load: a failed command's last lines (null once no longer kept); more: older lines were cut.
  | { type: 'tool-output'; sessionId: string; id: string; lines: string[] | null; more: boolean }
  // text comes only when the shown source changed since the last message. quiet: ms since the newest output across
  // sources; not exact when output older than the watch has no time, then it counts from when watching began.
  | {
    type: 'proc-log'; sessionId: string; taskId: string; ended: boolean; sources: LogSourceInfo[]; shown: string; source: LogSource; path?: string;
    text?: string; truncated?: boolean; quiet: { ms: number; exact: boolean } | null;
  }
  | ({ type: 'map'; sessionId: string } & MapPatch)
  // Plan limits are account-wide, so they go to every client.
  | { type: 'limits'; limits: Limits }
  | ({ type: 'replay'; sessionId: string; id: string } & ReplayInfo)
  // Spoken recaps go to every client; the global switch too.
  | VoiceClip
  | ReplayVoice
  // on is null when the server has no TTS installed.
  | { type: 'voice-on'; on: boolean | null }
  // Answers one client's voice-line; url is null when it could not be rendered.
  | { type: 'voice-line'; text: string; glitch: boolean; url: string | null }
  | SttMessage
  // Sent on connect and after each check; the server checks only at boot and on connect-check.
  | { type: 'connect-status'; status: ConnectStatus }
  // Goes to every client whenever the sign-in or sign-out flow moves.
  | { type: 'login'; login: LoginState }
  // Sent on connect once known and after each check; the server reads it only on codex-check.
  | { type: 'codex-status'; status: CodexStatus }
  // Goes to every client whenever the Codex sign-in or sign-out moves.
  | { type: 'codex-login'; login: CodexLoginState }
  // Answer to codex-models; the server caches the list until the account changes.
  | { type: 'codex-models'; models: CodexModel[]; error: string | null }
  // Answer to settings-load, or to settings-set with its id; error is null when it saved.
  | { type: 'settings'; settings: SettingsView; reply?: { id: string; error: string | null } }
  // Sent on connect and to every client whenever a check or an update moves.
  | { type: 'update'; update: UpdateStatus }
  // Answer to set-mode or set-model with a req: the settings in effect after it, and why it failed (null when applied).
  | { type: 'settings-result'; sessionId: string; req: string; settings: Settings; error: string | null }
  // The performance profile in effect; sent on connect and to every client when it changes. chosen is false until the user picks one.
  | { type: 'perf'; perf: PerfProfile; chosen: boolean }
  // Sent once per connection, only while no profile was chosen or forced; its arrival means the client may suggest Lite.
  | { type: 'machine'; facts: MachineFacts }
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
  // Answer to tree-find: the best matching file paths; more means some were left out. git: the list follows .gitignore.
  | ({ type: 'tree-found'; sessionId: string; query: string } & ({ paths: string[]; more: boolean; git: boolean } | { error: string }))
  | { type: 'changes-detail'; sessionId: string; id: string; path: string; diff: FileDiff | null }
  // Answer to changes-revert and changes-undo; undo is the token that takes this revert back (null after an undo or an error).
  | { type: 'changes-reverted'; sessionId: string; req: string; error: string | null; undo: string | null }
  | { type: 'changes-indexed'; sessionId: string; req: string; files: ChangeIndexFile[] }
  // Answer to changes-context; null when the old side is not kept.
  | { type: 'changes-context-lines'; sessionId: string; id: string; path: string; from: number; lines: string[] | null }
  // Answer to mention-find and mention-list. List only: abs is the listed folder, base how a mention names it.
  | { type: 'mentions'; req: string; entries: MentionEntry[]; more: boolean; abs?: string; base?: string; error?: string }
  // Answer to skills-load.
  | { type: 'skills'; catalog: SkillCatalog }
  // Answer to skills-suggest; a superseded request gets no answer.
  | { type: 'skills-suggested'; sessionId: string; picks: SkillPick[]; error?: string }
  // Organize: progress after each batch, then one final answer; a fresh catalog follows it (and a stop).
  | { type: 'skills-organize-progress'; done: number; total: number }
  | { type: 'skills-organized'; found: number; checked: number; error?: string }
  | WatchTimelineMessage
  | WatchSubsMessage
  | AgentActivityMessage;

// Answer to agent-activity, in the watch-subs shape; aid is the panel row id.
// Joins ServerMessage together with its case in web/src/store.ts.
export type AgentActivityMessage = { type: 'agent-activity'; sessionId: string; subs: WatchSub[] };

// Answer to watch-load, oldest first.
export type WatchTimelineMessage = { type: 'watch-timeline'; sessionId: string } & WatchPage;
// Answer to watch-subs: only the subagents with something new since the cursors asked for.
export type WatchSubsMessage = { type: 'watch-subs'; sessionId: string; subs: WatchSub[] };

// path is what a mention writes: relative inside the session folder, else "~/…" or absolute; folders end in "/".
export type MentionEntry = { name: string; path: string; dir: boolean };
// ignored: git ignores it in the session's repo.
export type TreeEntry = { name: string; dir: boolean; link?: true; ignored?: true };
// text is null for binary, too large or failed reads.
export type TreeFile = { text: string | null; size: number; binary: boolean; tooLarge: boolean; error?: string };

// A /command the composer offers; skill marks one defined by a user, project, plugin or MCP server.
export type SlashItem = { name: string; description: string; hint: string; aliases?: string[]; skill?: boolean };

// Skills library: the tree's first level. key is what SkillInfo.origin points at.
export type SkillOriginKind = 'user' | 'project' | 'plugin' | 'synced' | 'codex' | 'codex-plugin';
export type SkillOrigin = { key: string; label: string; kind: SkillOriginKind };
// One SKILL.md. key is unique: the /command when the slash menu has it, else a made-up name; parent is the key of the
// skill folder a nested one lives in. link is the skill's source page, only when one is known.
// authorInferred: the author came from Organize reading the skill, not from its frontmatter or repo.
export type SkillInfo = { key: string; name: string; desc: string; path: string; origin: string; parent?: string; cmd?: string; link?: string; author?: string; authorInferred?: true };
// authorsPending: skills with no author that Organize has not read yet.
export type SkillCatalog = { origins: SkillOrigin[]; skills: SkillInfo[]; authorsPending: number };
// A suggested skill: key from the catalog, why in the user's language.
export type SkillPick = { key: string; why: string };

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
// always: allowed for the rest of the asking agent's session.
export type AskReply = { answers?: Record<string, string>; mode?: Mode; feedback?: string; always?: true };

// A replay manifest, loaded on demand; page urls are served read-only from the manifest's folder.
export type ReplayPage = { id: string; title: string; url: string; width: number; height: number };
export type ReplayInfo = { title: string; pages: ReplayPage[]; error: string | null };
// A page picture the replay tool rendered for its report; old results without png lines have none.
export type ReplayPng = { id: string; png: string };

export type ClientMessage =
  | { type: 'hello'; sessionId: string | null; afterSeq: number; serverId?: string }
  // App-level heartbeat: the server answers pong, so the client notices a link the browser still thinks is open.
  | { type: 'ping' }
  // Every session this client peeks at besides the one on screen; replaces the previous set.
  | { type: 'peek'; ids: string[] }
  // id becomes the message's id, so the client can match the echo to what it shows as sending.
  // style starts the CLI with that reply style; seen becomes a note to the model on this turn.
  | { type: 'send'; sessionId: string; text: string; pastes?: string[]; files?: Upload[]; thumbs?: (string | null)[]; links?: TextLink[]; id?: string; style?: ReplyStyle; seen?: StretchSeen }
  | { type: 'permission-answer'; sessionId: string; id: string; allow: boolean; reply?: AskReply }
  // A ```ui block of the latest reply that fell back to raw JSON; index is its order among the reply's ui blocks.
  | { type: 'ui-block-failed'; sessionId: string; itemId: string; index: number; blockType: string; why: string }
  | { type: 'interrupt'; sessionId: string }
  // Ends a CLI that did not answer a stop; the transcript stays and the next send resumes it.
  | { type: 'force-stop'; sessionId: string }
  // Restarts the session's CLI so new instructions, settings and skills apply; the transcript stays.
  | { type: 'reload'; sessionId: string; style?: ReplyStyle }
  // Runs the context handoff now, past the automatic retry limit; refused while the session works.
  | { type: 'handoff'; sessionId: string }
  // The handoff card's ×: stops a live handoff, or clears a finished card.
  | { type: 'handoff-dismiss'; sessionId: string }
  // Turns Remote Control on or off; a refusal comes back as a notice.
  | { type: 'remote-control'; sessionId: string; on: boolean }
  // fresh: the user is looking at the list (Ctrl+K, Start), so stale Codex rows may boot the app-server to refresh.
  | { type: 'list-past'; fresh?: boolean }
  | { type: 'find-dirs'; query: string }
  // Full-text search over saved conversations, answered with search-found; cwd limits it to one folder.
  | { type: 'search'; query: string; cwd?: string }
  // A question in plain words; Haiku picks matching sessions from local candidates. One in flight per client.
  | { type: 'search-ai'; query: string; cwd?: string }
  // The question changed before the answer came; ends the model call.
  | { type: 'search-ai-stop' }
  // Omitted settings come from the server's defaults for new tabs.
  | ({ type: 'open'; cwd: string } & Partial<Settings>)
  | { type: 'resume'; id: string; widget?: true }
  // req asks for a settings-result answer.
  | { type: 'set-mode'; sessionId: string; mode: Mode; req?: string }
  // keys name files in ~/.claude/mcp; servers maps other server names to on/off. mcp-status asks for the menu with fresh states.
  | { type: 'set-mcp'; sessionId: string; keys: string[]; servers?: Record<string, boolean>; keepDefault?: boolean }
  | { type: 'mcp-status'; sessionId: string }
  // Starts a server's sign-in, or reconnects it once the user signed in elsewhere.
  | { type: 'mcp-auth' | 'mcp-reconnect'; sessionId: string; server: string }
  | { type: 'set-model'; sessionId: string; model: string; effort: Effort; req?: string }
  // A model of the other provider on a tab with messages: a new tab on it, seeded with a handoff of this one.
  | { type: 'switch-provider'; sessionId: string; model: string; effort: Effort }
  // Close stops the live query; the transcript stays.
  | { type: 'close'; sessionId: string }
  | { type: 'rename'; id: string; title: string }
  | { type: 'archive'; id: string; archived: boolean }
  // worktree: also remove the managed worktree of a branch tab (refused when it has uncommitted changes).
  | { type: 'delete'; id: string; worktree?: true }
  // A new tab forked from this one through item (a user turn or a reply), optionally in its own git worktree.
  | { type: 'branch'; sessionId: string; item: string; worktree?: true }
  | { type: 'list-dirs'; path: string }
  | { type: 'stop-task'; sessionId: string; taskId: string }
  | { type: 'agent-message'; sessionId: string; agentId: string; text: string }
  // Streams one process log to this client; null stops it. source pins one of its sources (a LogSourceInfo key).
  | { type: 'watch-log'; sessionId: string; taskId: string | null; source?: string }
  | { type: 'dismiss'; sessionId: string; id: string }
  // The sheet opened: old chapters may get Haiku titles now.
  | { type: 'map-open'; sessionId: string }
  // id is the ask_round tool_use id; one answer per question, in order.
  | { type: 'round-answer'; sessionId: string; id: string; answers: RoundPick[]; extra?: string }
  // id is the ask_prototype tool_use id; empty values and note means "reply in chat".
  | { type: 'proto-answer'; sessionId: string; id: string; values: Record<string, unknown>; note: string; variant?: string | null; comments?: ProtoComment[] }
  // id is the ask_checklist tool_use id; no ticks and no note means "reply in chat".
  | { type: 'checklist-answer'; sessionId: string; id: string; ticked: number[]; note: string }
  // id is the ask_upload tool_use id; no files cancels the ask.
  | { type: 'upload-answer'; sessionId: string; id: string; files?: Upload[] }
  // Takes a queued message back before Claude reads it; now sends it again as an interrupting message.
  | { type: 'unqueue'; sessionId: string; id: string; then: 'remove' | 'now' }
  | { type: 'replay-load'; sessionId: string; id: string }
  | { type: 'changes-load'; sessionId: string; id: string; path: string }
  // Puts a card's file back as it was before the turn, or only one hunk (its index in changes-detail); refused mid-turn.
  | { type: 'changes-revert'; sessionId: string; id: string; path: string; hunk?: number; req: string }
  // Takes a revert back by the undo token changes-reverted gave.
  | { type: 'changes-undo'; sessionId: string; undo: string; req: string }
  | { type: 'changes-index'; sessionId: string; req: string }
  // Unchanged old-side lines [from, from + count) of a card's file, 1-based, for a collapsed gap.
  | { type: 'changes-context'; sessionId: string; id: string; path: string; from: number; count: number }
  | { type: 'agent-load'; sessionId: string; id: string }
  // A failed command row's output; id is its tool_use id.
  | { type: 'tool-output-load'; sessionId: string; id: string }
  // The agents panel's detail: [row id, rev cursor] pairs, at most 8; Claude subagents read from their transcripts, Codex agents from memory.
  | { type: 'agent-activity'; sessionId: string; since: [string, number][] }
  // Watch mode's timeline: the newest page without before, then older pages with the reply's before.
  | { type: 'watch-load'; sessionId: string; before?: number }
  // Watch mode polls running subagents: [spawning tool_use id, rev cursor] pairs, at most 32.
  | { type: 'watch-subs'; sessionId: string; since: [string, number][] }
  // Events older than seq before, about a page, starting at a prompt; until (a seq) or id (an event id) stretches the page back to include it.
  // Seqs of a resumed session's history before its last compaction are 0 or below.
  | { type: 'history-load'; sessionId: string; before: number; until?: number; id?: string }
  // Searches every event of the session, loaded by this client or not.
  | { type: 'history-find'; sessionId: string; query: string }
  // The user started typing: the server starts that session's CLI so the first reply skips its boot.
  | { type: 'warm'; sessionId: string; style?: ReplyStyle }
  | { type: 'tree-list' | 'tree-read'; sessionId: string; path: string }
  // Go to file: paths of the session folder matching query.
  | { type: 'tree-find'; sessionId: string; query: string }
  // The composer's @ menu and file picker: find searches the session folder's files and folders; list reads one folder
  // anywhere (relative paths start at the session folder, "~" is home). req pairs the answer with its ask.
  | { type: 'mention-find'; sessionId: string; query: string; req: string }
  | { type: 'mention-list'; sessionId: string; path: string; req: string }
  | { type: 'voice-set'; on: boolean }
  // Voice input: warm boots the engine on composer intent; start and stop follow the Space hold, cancel drops a take.
  | { type: 'stt-warm' }
  | { type: 'stt-start' | 'stt-stop' | 'stt-cancel'; take: number }
  // The Listen button: reply is the agent item id, text its raw reply and prompt the request that led to it.
  | { type: 'voice-recap'; sessionId: string; reply: string; prompt: string; text: string }
  // The replay viewer's Listen button: one spoken summary of the whole replay, made once and cached.
  | { type: 'replay-voice'; sessionId: string; id: string }
  // The sound robot's live part of a line (what finished, by name), in its own voice.
  | { type: 'voice-line'; text: string; glitch: boolean }
  | { type: 'connect-check' }
  | { type: 'login-start' | 'login-cancel' | 'logout' }
  // The code the sign-in page shows, written to the waiting CLI's stdin.
  | { type: 'login-code'; code: string }
  // codex-check starts Codex's app-server if needed and reads the account.
  | { type: 'codex-check' | 'codex-login-cancel' | 'codex-logout' | 'codex-models' }
  | { type: 'codex-login-start'; flow: CodexLoginFlow }
  | { type: 'settings-load' }
  | { type: 'settings-set'; id: string; patch: SettingsPatch }
  // update-check asks GitHub now; update installs that release tag and restarts the app.
  | { type: 'update-check' }
  | { type: 'update'; tag: string }
  | { type: 'terminal-answer'; id: string; allow: boolean; always?: true }
  | { type: 'terminal-hooks-load' }
  | { type: 'terminal-hooks-preview'; on: boolean }
  | { type: 'terminal-hooks-set'; on: boolean; base: string; req: string }
  | { type: 'folder-menu-load' }
  | { type: 'folder-menu-set'; on: boolean; req: string }
  // The window gained focus, so it is the one a right-click open goes to.
  | { type: 'seen' }
  // Brings the window with this title to the front, right after an open-folder.
  | { type: 'raise'; title: string }
  // thread groups one panel's follow-ups; turns is what the panel already shows.
  // deep: answer from a fork of the whole conversation with the session's model instead of the recent messages with Sonnet.
  | { type: 'explain'; sessionId: string; thread: string; excerpt: string; turns: ExplainTurn[]; question: string; deep?: boolean }
  // A click in the plugin band; key names the element, path finds a keyless one; href is a clicked link.
  | { type: 'ui-press'; sessionId: string; plugin: string; key: string | null; path: number[]; href?: string }
  | { type: 'ui-prompt-answer'; sessionId: string; id: string; answer: UiPromptAnswer }
  // The skills library: the catalog (with the session's project skills and slash names), and a model's picks for this chat.
  // draft is the composer's unsent text. One suggestion in flight per client; stop ends it.
  | { type: 'skills-load'; sessionId?: string }
  | { type: 'skills-suggest'; sessionId: string; draft: string }
  | { type: 'skills-suggest-stop' }
  // Finds authors for skills that have none, with the tab's provider (none: the signed-in default). One run per client.
  | { type: 'skills-organize'; sessionId?: string }
  | { type: 'skills-organize-stop' };

// Browser panel. It talks over its own socket (/ws/browser); live frames arrive there as binary JPEG messages.
export type BrowserStatus = 'stopped' | 'starting' | 'live' | 'error';
export type BrowserTab = { id: string; title: string; url: string };
// The tool layers that can drive the panel's Chrome, one header badge each.
export type BrowserTool = 'claude' | 'playwright' | 'devtools';
// engine names the Chrome in use; port is its DevTools port, which the panel packs attach to. held: stopped by the owner,
// so an open panel waits for Start instead of starting it again. tools: layers some running session has on. agents: the
// owner's switch that lets agents use the panel; off, they never start or route to it. unavailable: layers the panel
// cannot run on this machine, with the reason shown to the owner.
// rec: the running recording (since: epoch ms; saving once stopped, until the file is written). saved: the newest
// finished one. recWhy: why recording cannot run here; recError: why the last recording failed.
// setupWindow: the panel's profile is open as a normal Chrome window on the desktop, so the panel shows no page until it
// closes. setupError: why the last setup window could not open or closed with an error.
export type BrowserState = {
  status: BrowserStatus; error: string | null; engine: string | null; port: number | null; held: boolean; agents: boolean;
  tabs: BrowserTab[]; active: string | null; canBack: boolean; canForward: boolean; loading: boolean; tools: BrowserTool[];
  unavailable: Partial<Record<BrowserTool, string>>;
  rec: { since: number; title: string | null; saving?: boolean } | null; saved: BrowserVideo | null; recWhy: string | null; recError: string | null;
  claude: BrowserClaudeSetup | null; setupWindow: boolean; setupError: string | null;
  // An agent's tool call is running on this Chrome.
  driving: boolean;
};
// How far Claude in Chrome is set up in the panel's profile, read from its files; null until checked or when the panel
// cannot host it here. host: Claude Code's native host is reachable. signedIn: the extension stored its bridge device id.
// flatpak: the panel runs Flatpak Chrome, which /chrome does not set up. desktop: a setup window can open on the desktop.
// checked: epoch ms of the last check.
export type BrowserClaudeSetup = { extension: boolean; host: boolean; signedIn: boolean; flatpak: boolean; desktop: boolean; checked: number };
// A saved recording of the panel: src and poster (its first frame) are signed URLs; ms is its length.
export type BrowserVideo = { path: string; src: string; poster: string | null; ms: number; w: number; h: number; bytes?: number; title?: string | null };
// A finished recording in the panel's library; at is when it started (epoch ms).
export type BrowserRecording = BrowserVideo & { at: number };
// What keeps Chrome running: an open panel, a session with a panel pack on, a recording, or nothing (it stops once idle).
export type BrowserWhy = 'panel' | 'session' | 'recording' | 'idle';
// meta: the viewport size in CSS px that the next frames show; input coordinates use it.
// activity and run go only to watch sockets (/ws/browser?watch=1): a session's tool call on a layer, turn counting that
// session's turns; and whether Chrome runs, for the header icon.
// cursor: an agent moved or pressed the mouse in the shown tab, at viewport CSS px; the owner's own input never sends it.
// shape is the page's cursor at that point: a link hand, a text I-beam, or the arrow for everything else.
export type CursorShape = 'arrow' | 'hand' | 'text';
export type BrowserServerMessage =
  | { type: 'state'; state: BrowserState }
  | { type: 'meta'; w: number; h: number }
  | { type: 'cursor'; kind: 'move' | 'down'; x: number; y: number; shape: CursorShape }
  // Answer to record-list, then pushed again to that socket whenever the library changes; newest first.
  | { type: 'recordings'; list: BrowserRecording[] }
  | { type: 'activity'; tool: BrowserTool; session: string; turn: number }
  // show_url opened a page for that session's user to look at.
  | { type: 'show'; session: string }
  | { type: 'run'; status: BrowserStatus; why: BrowserWhy | null; agents: boolean };
export type BrowserButton = 'none' | 'left' | 'middle' | 'right';
// Longest text message; even at 6 JSON bytes per char it stays under the socket's 1 MiB frame cap.
export const BROWSER_TEXT_MAX = 100_000;
// mods is the CDP bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.
export type BrowserClientMessage =
  // open keeps Chrome alive; visible streams frames, at most w x h device px. dpr turns that back into the CSS size the window takes.
  // sw x sh is the panel's monitor in CSS px, which sizes the hidden screen.
  | { type: 'view'; open: boolean; visible: boolean; w: number; h: number; dpr?: number; sw?: number; sh?: number }
  | { type: 'start' | 'stop' | 'back' | 'forward' | 'reload' | 'tab-new' }
  | { type: 'navigate'; url: string }
  // tab-open opens url in a new tab and shows it; claude-check re-reads the Claude in Chrome setup now.
  | { type: 'tab-open'; url: string }
  | { type: 'claude-check' }
  // Opens or closes the setup window: the panel's profile as a normal Chrome window on the desktop.
  | { type: 'setup-window'; open: boolean }
  // The agents switch, saved in the config; watch sockets may send it too.
  | { type: 'agents'; on: boolean }
  // Starts or stops recording the active tab; record-delete removes a saved recording.
  | { type: 'record'; on: boolean }
  | { type: 'record-delete'; path: string }
  // record-list asks for the library (and its later changes); record-clear deletes every finished recording.
  | { type: 'record-list' | 'record-clear' }
  | { type: 'tab-select' | 'tab-close'; id: string }
  | { type: 'mouse'; kind: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button: BrowserButton; buttons: number; clicks: number; mods: number; dx: number; dy: number }
  | { type: 'key'; kind: 'down' | 'up'; key: string; code: string; keyCode: number; text: string; mods: number; location: number; repeat: boolean }
  | { type: 'text'; text: string };
