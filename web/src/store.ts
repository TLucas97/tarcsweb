import { create } from 'zustand';
import type {
  AiHit, Attachment, DiffDetail, Dir, ExplainEvent, Folder, Limits, LogSource, LogSourceInfo, Panel, PastSession, ReplayInfo, RichDetail, SearchHit, SeqEvent, ServerMessage, SessionMap, SessionSummary,
  Settings, Status, VoiceClip, ReplayVoice, AskReply, Question, Mode, SlashItem, ChangeCard, McpRow, McpPhase, RoundPick, GenImage, BrowserVideo, Wake, TextLink,
  AskedFile, ProtoAnswer, ReplayPng, ChecklistAnswer, AgentState, ProcState,
} from '../../server/protocol.ts';
import { dropDiffs, dropSessionDiffs, putDiff, putGaps, putIndex, putReverted } from './diffs.ts';
import { applyTree } from './tree.ts';
import { mergePanel, putAgentText } from './panel.ts';
import { deliverTimeline } from './watch/open.ts';
import { putAgentActivity } from './agentActivity.ts';

// A sign-in started from the MCP menu: asking for the page, waiting for the user there, or checking once they are back.
export type McpAuth = { step: 'opening' | 'waiting' | 'checking'; url?: string; manual?: boolean; error?: string };
export type McpList = { servers: McpRow[]; live: boolean; phase?: McpPhase; error?: string; auth?: Record<string, McpAuth> };

export type ToolResult = { error: string | null; choice?: number | null; answer?: string; round?: RoundPick[] | null; roundExtra?: string; proto?: ProtoAnswer | null; checklist?: ChecklistAnswer | null; png?: string; img?: string; images?: GenImage[]; ms?: number; brief?: string; video?: BrowserVideo; uploads?: AskedFile[]; pagePngs?: ReplayPng[] };
// note: a plain explanation of why a failed Bash call failed.
// group: the list this call sits in, so a change to the call also renews its group. desc: a Bash call's own description.
export type ToolItem = { kind: 'tool'; id: string; name: string; verb: string; summary: string; diff: DiffDetail | null; result: ToolResult | null; note?: string; group?: string; desc?: string };
export type Tldr = { text: string; words: number };
// seen: Claude read back the picture of this render_ui call.
// replaced: a newer card of the same replay, or a render_ui call with `replace`, took its place, so this one renders nothing.
// at: when the call was first seen (epoch ms), for cards that time themselves.
export type RichItem = { kind: 'rich'; id: string; name: string; detail: RichDetail; partial: boolean; result: ToolResult | null; seen: boolean; replaced?: boolean; at?: number };
// born, touched: seqs of the event that made the item and of the last one that changed it, set by Draft.put; dropOlder
// cuts only where every row above was last touched before the cut row was born, so a reload rebuilds them exactly.
type Stamp = { born?: number; touched?: number };
// at on user, agent, group and update items: when the row first arrived (epoch ms), for the update header and the "New" divider.
export type Item = Stamp & (
  | { kind: 'user'; id: string; text: string; pastes?: string[]; files?: Attachment[]; links?: TextLink[]; queued?: boolean; stopped?: boolean; phone?: boolean; at?: number }
  | { kind: 'agent'; id: string; text: string; tldr?: Tldr; at?: number }
  | ToolItem
  // Consecutive plain tool calls, shown as one collapsible list.
  | { kind: 'group'; id: string; tools: string[]; at?: number }
  // The start of a turn the agent opened on its own; from names what woke it.
  | { kind: 'update'; id: string; from: Wake[]; at?: number }
  // An agent's report woke Main and it did not reply; done once the user sends anything after it.
  | { kind: 'quiet'; id: string; done?: boolean; at?: number }
  | RichItem
  | {
      kind: 'permission'; id: string; tool: string; summary: string; command?: string; title?: string; defaultToNo?: boolean; answer: boolean | null; detail?: DiffDetail; questions?: Question[];
      plan?: string; back?: Mode; reply?: AskReply; elsewhere?: boolean; always?: boolean; cancelled?: boolean;
    }
  | { kind: 'error'; id: string; message: string }
  // The cards of one turn's file changes, one per agent; always the last item of its turn.
  | { kind: 'changes'; id: string; cards: ChangeCard[] }
);
export type ReplayView = { key: string; page: number };
// The explain panel: one thread of answers about a selected excerpt; svg is the answer's drawing, if any.
export type ExplainAnswer = { question: string; text: string; svg: string | null };
export type ExplainView = {
  sessionId: string; thread: string; excerpt: string; turns: ExplainAnswer[]; status: 'loading' | 'ready' | 'error'; pending: string; error: string;
  // Whole conversation with the session's model; off means Sonnet with the recent messages.
  deep: boolean;
};
// A spoken recap waiting, rendering or ready; one per session, oldest first.
export type Recap = Omit<VoiceClip, 'type'>;
export type ReplayNarration = Omit<ReplayVoice, 'type'>;
// The clip in the shared voice player; id is the recap id or the replay key. It stays until the user closes it.
export type VoiceTrack = {
  kind: 'recap' | 'replay'; id: string; sessionId: string; url: string; text: string;
  phase: 'playing' | 'paused' | 'blocked' | 'done' | 'failed';
};

// An agent's change card and the conversation item that holds it.
export type CardRef = [item: string, card: ChangeCard];
export type Conv = {
  order: string[]; items: Record<string, Item>; status: Status; lastSeq: number;
  // Indexes kept by the reducer so selectors stay O(1): open asks and choices, the newest plan, change cards by agent.
  asks: number; lastPlan: string | null; cardsOf: Record<string, CardRef[]>;
  // A session opened without a cached conversation, until its backlog (or its map, when it has none) arrives.
  loading: boolean;
  // The server holds events older than this seq (history-load's before); null once the start is loaded.
  older: number | null;
  // Results, notes and summaries for items not loaded yet; replayed when an older page brings them in.
  orphans: SeqEvent[];
  // The reply being written this turn; the row under a trailing change card can still be live.
  streaming: string | null;
};
export type Listing = { branch: string | null; dirs: Dir[] } | { error: string };
export type PaletteMode = 'switch' | 'folder';
// An image open full screen: what is on screen now, the full file if any, and where it opened from.
export type Viewing = { src: string; full: string | null; alt: string; from: DOMRect; ratio: number };
// inline: shown in the full-screen agents view instead of the popover. pick: the source the user chose, null follows the newest.
// quiet.at: when the newest output came, on this client's clock.
export type ProcLog = {
  sessionId: string; taskId: string; text: string; truncated: boolean; source: LogSource | null; path?: string; inline?: boolean;
  sources: LogSourceInfo[]; shown: string | null; pick: string | null; quiet: { at: number; exact: boolean } | null;
};

type State = Conv & {
  serverId: string | null;
  connected: boolean;
  current: string | null;
  roster: SessionSummary[];
  past: PastSession[];
  // A folder the user picked in the palette; while null the dock follows the current session's folder.
  folder: string | null;
  folders: Folder[];
  home: string;
  // Folder listings for the new-session browser, by absolute path.
  dirs: Record<string, Listing>;
  // Folders under home matching the picker's typed name.
  found: { query: string; dirs: Dir[] } | null;
  // Past conversations whose text matches the palette's query; replaced on each answer.
  searched: { query: string; cwd: string | null; hits: SearchHit[]; indexing: boolean } | null;
  // The AI search the user asked for in the palette; pending until its answer arrives.
  aiSearch: { query: string; cwd: string | null; pending: boolean; hits: AiHit[]; error?: string } | null;
  // Open sessions in the order they first showed here, or as the reader dragged them; dock tabs, the folder menu's
  // numbers and Ctrl/Alt+digit follow it, so nothing shifts on a switch. Kept across reloads.
  dockOrder: string[];
  // Open sessions, most recently shown first; decides which tabs overflow and where Alt+` goes.
  recent: string[];
  // The open or resume sent and not answered yet ("new:<cwd>" or "resume:<id>"); a second one waits for it.
  pendingOpen: string | null;
  notice: string | null;
  // The notice confirms something instead of reporting an error.
  noticeInfo: boolean;
  palette: PaletteMode | null;
  // Folder page the palette opens on, instead of the full list.
  paletteAt: string | null;
  transferFrom: string | null;
  // Settings a new session starts with.
  defaults: Settings;
  // Agents panel snapshots, by session id.
  panels: Record<string, Panel>;
  // Per-row lookups into panels, rebuilt only when the rows change: agent state by row id, job state by Bash tool id.
  panelIdx: Record<string, { agents: Record<string, AgentState>; procs: Record<string, ProcState> }>;
  // The process whose log is open; text is null until the first read arrives.
  log: ProcLog | null;
  // Session map snapshots (chapters, heads-up, usage), by session id.
  maps: Record<string, SessionMap>;
  // Plan limits, shared by every session; null until the first rate_limit_event.
  limits: Limits | null;
  // Loaded replay manifests by "sessionId:toolId", and the one open in the viewer.
  replays: Record<string, ReplayInfo>;
  replayView: ReplayView | null;
  // Spoken replay summaries by the same key; the server caps them per session and they go when it closes.
  replayVoices: Record<string, ReplayNarration>;
  viewer: Viewing | null;
  // null: voice is not installed on the server.
  voiceOn: boolean | null;
  recaps: Recap[];
  voiceTrack: VoiceTrack | null;
  // The replay summary the user asked to hear; it plays when ready, even with the viewer closed.
  voiceWant: string | null;
  explain: ExplainView | null;
  // Slash menu lists by session id, and the latest any session sent (for a session that has none yet).
  commands: Record<string, SlashItem[]>;
  lastCommands: SlashItem[];
  // MCP menus by session id, loaded when the menu opens.
  mcpLists: Record<string, McpList>;
  // Stops the user asked for, counted; a turn that ends after one was stopped, not done.
  stops: number;
  // Setting changes sent but not answered yet, by session id, oldest first.
  settingsPending: Record<string, PendingSetting[]>;
  // An agent a heads-up asked the Agents panel to show; n bumps so the same agent can be asked again.
  agentPick: { sessionId: string; id: string; n: number } | null;
};

export type PendingSetting = { req: string; patch: Partial<Settings> };

const emptyConv = (loading = false): Conv => ({ order: [], items: {}, status: 'idle', lastSeq: 0, asks: 0, lastPlan: null, cardsOf: {}, loading, older: null, orphans: [], streaming: null });
const ORPHANS_MAX = 300;
// Rows a new prompt looks back through for open quiet notices.
const QUIET_SCAN = 50;

export const useStore = create<State>(() => ({
  ...emptyConv(),
  serverId: null,
  connected: false,
  current: null,
  roster: [],
  past: [],
  folder: null,
  folders: [],
  home: '',
  dirs: {},
  found: null,
  searched: null,
  aiSearch: null,
  dockOrder: savedOrder(),
  recent: [],
  pendingOpen: null,
  notice: null,
  noticeInfo: false,
  palette: null,
  paletteAt: null,
  transferFrom: null,
  // Replaced by the server's on hello.
  defaults: { mode: 'default', model: 'claude-sonnet-5-5', effort: 'high' },
  panels: {},
  panelIdx: {},
  log: null,
  maps: {},
  limits: null,
  replays: {},
  replayView: null,
  replayVoices: {},
  viewer: null,
  voiceOn: true,
  recaps: [],
  voiceTrack: null,
  voiceWant: null,
  explain: null,
  commands: {},
  lastCommands: [],
  mcpLists: {},
  stops: 0,
  settingsPending: {},
  agentPick: null,
}));

// Conversations of sessions not on screen, so switching back is instant; least recently shown drop first.
const CONV_CACHE_MAX = 5;
// Folder listings kept for the new-session browser.
const DIRS_MAX = 64;
const convCache = new Map<string, Conv>();

function cacheConv(s: State) {
  if (!s.current) return;
  convCache.delete(s.current);
  convCache.set(s.current, {
    order: s.order, items: s.items, status: s.status, lastSeq: s.lastSeq, asks: s.asks, lastPlan: s.lastPlan, cardsOf: s.cardsOf, loading: s.loading, older: s.older, orphans: s.orphans,
    streaming: s.streaming,
  });
  while (convCache.size > CONV_CACHE_MAX) convCache.delete(convCache.keys().next().value!);
}

// Where a cached, fully loaded conversation left off; null when switching to it has to wait for a backlog anyway.
export function cachedSeq(id: string): number | null {
  const c = convCache.get(id);
  return c && !c.loading ? c.lastSeq : null;
}

// The cached conversation moves back into the store, or an empty one waits for the backlog.
function takeConv(id: string | null): Conv {
  if (!id) return emptyConv();
  const c = convCache.get(id);
  convCache.delete(id);
  return c ?? emptyConv(true);
}

// A group's calls, cached per group object; the reducer renews the group whenever one of its calls changes.
const NO_TOOLS: ToolItem[] = [];
const groupCache = new WeakMap<Item, ToolItem[]>();
export function groupTools(s: State, id: string) {
  const g = s.items[id];
  if (g?.kind !== 'group') return NO_TOOLS;
  let tools = groupCache.get(g);
  if (!tools) groupCache.set(g, (tools = g.tools.map((t) => s.items[t]).filter((t): t is ToolItem => t?.kind === 'tool')));
  return tools;
}

const NO_CARDS: CardRef[] = [];
export const cardsOf = (s: State, owner: string) => s.cardsOf[owner] ?? NO_CARDS;

// The newest row of the turn itself: change cards sit after it, so they are skipped (a short, bounded walk).
export function lastRow(c: Conv): Item | undefined {
  for (let i = c.order.length - 1, n = 0; i >= 0 && n < 4; i--, n++) {
    const it = c.items[c.order[i]];
    if (it?.kind !== 'changes') return it;
  }
  return undefined;
}

export function currentSummary(s: State) {
  return s.current ? s.roster.find((r) => r.id === s.current) : undefined;
}

// Swaps the visible conversation; the caller subscribes the socket afterwards.
export function selectSession(id: string | null) {
  useStore.setState((s) => {
    // The target leaves the cache before the outgoing one goes in, so a full cache never evicts the session being opened.
    // Its seq already went out with the early hello, and an evicted one would land those few events on an empty conversation.
    const taken = id === s.current ? null : takeConv(id);
    cacheConv(s);
    const next = taken ?? takeConv(id);
    const dockOrder = id && !s.dockOrder.includes(id) ? [...s.dockOrder, id] : s.dockOrder;
    const recent = id ? [id, ...s.recent.filter((d) => d !== id)] : s.recent;
    return { ...next, current: id, dockOrder, recent, log: null };
  });
}

export function setConnected(connected: boolean) {
  // Answers to changes sent on a closed socket never come; the roster after the reconnect settles them.
  useStore.setState(connected ? { connected } : { connected, settingsPending: {} });
}

export function setPalette(palette: PaletteMode | null, at: string | null = null, transferFrom: string | null = null) {
  useStore.setState({ palette, paletteAt: at, transferFrom, notice: null });
}

// Optimistic, so quick repeated changes (Shift+Tab twice) build on each other before the echo.
export function patchSummary(id: string, patch: Partial<SessionSummary>) {
  useStore.setState((s) => ({ roster: s.roster.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
}

let reqNo = 0;
export const settingReq = () => `${Date.now().toString(36)}-${++reqNo}`;

// Shown at once and marked pending; roster broadcasts keep it until the server's settings-result settles it.
export function beginSetting(sessionId: string, req: string, patch: Partial<Settings>) {
  useStore.setState((s) => ({
    roster: s.roster.map((r) => (r.id === sessionId ? { ...r, ...patch } : r)),
    settingsPending: { ...s.settingsPending, [sessionId]: [...(s.settingsPending[sessionId] ?? []), { req, patch }] },
  }));
}

export function pickAgent(sessionId: string, id: string) {
  useStore.setState((s) => ({ agentPick: { sessionId, id, n: (s.agentPick?.n ?? 0) + 1 } }));
}

// Pending patches, oldest first, over what the server last said.
const withPending = (r: SessionSummary, list: PendingSetting[] | undefined) => (list?.length ? Object.assign({ ...r }, ...list.map((p) => p.patch)) as SessionSummary : r);

// An MCP toggle shows at once; the server's next list settles it.
export function patchMcpList(id: string, patch: Partial<McpList>) {
  useStore.setState((s) => ({ mcpLists: { ...s.mcpLists, [id]: { ...(s.mcpLists[id] ?? { servers: [], live: false }), ...patch } } }));
}

export function setMcpAuth(id: string, server: string, auth: McpAuth | null) {
  const list = useStore.getState().mcpLists[id];
  const { [server]: _, ...rest } = list?.auth ?? {};
  patchMcpList(id, { auth: auth ? { ...rest, [server]: auth } : rest });
}

// Search hits can be sessions outside the past list, so edits patch them too.
function patchHits(s: State, id: string, patch: Partial<PastSession> | null): Pick<State, 'searched' | 'aiSearch'> {
  const edit = <T extends { hits: SearchHit[] }>(r: T | null): T | null => {
    if (!r?.hits.some((h) => h.id === id)) return r;
    const hits = patch ? r.hits.map((h) => (h.id === id ? { ...h, ...patch } : h)) : r.hits.filter((h) => h.id !== id);
    return { ...r, hits } as T;
  };
  return { searched: edit(s.searched), aiSearch: edit(s.aiSearch) };
}

export function renameLocal(id: string, name: string) {
  useStore.setState((s) => ({
    roster: s.roster.map((r) => (r.id === id ? { ...r, name } : r)),
    past: s.past.map((p) => (p.id === id ? { ...p, name } : p)),
    ...patchHits(s, id, { name }),
  }));
}

export function patchPast(id: string, patch: Partial<PastSession>) {
  useStore.setState((s) => ({ past: s.past.map((p) => (p.id === id ? { ...p, ...patch } : p)), ...patchHits(s, id, patch) }));
}

export function removePast(id: string) {
  useStore.setState((s) => ({ past: s.past.filter((p) => p.id !== id), ...patchHits(s, id, null) }));
}

// Takes a session off the dock; if it was on screen, the next dock session (or none) shows. Returns true when the view changed.
export function dropOpen(id: string) {
  const s = useStore.getState();
  convCache.delete(id);
  const roster = s.roster.filter((r) => r.id !== id);
  const dockOrder = s.dockOrder.filter((d) => d !== id);
  const recent = s.recent.filter((d) => d !== id);
  if (s.current !== id) {
    useStore.setState({ roster, dockOrder, recent });
    return false;
  }
  const next = recent[0] ?? dockOrder[0] ?? null;
  useStore.setState({ ...takeConv(next), roster, dockOrder, recent, current: next });
  return true;
}

// Hidden at once; the server's next snapshot confirms it.
export function dismissLocal(sessionId: string, id: string) {
  useStore.setState((s) => {
    const m = s.maps[sessionId];
    return m ? { maps: { ...s.maps, [sessionId]: { ...m, headsUps: m.headsUps.filter((h) => h.id !== id) } } } : s;
  });
}

export function setDefaults(patch: Partial<Settings>) {
  useStore.setState((s) => ({ defaults: { ...s.defaults, ...patch } }));
}

// pick is an option index or the user's own words, a round's answers, or what a prototype or checklist card sent.
// extra: a round's free note, beside its picks.
export function pickChoiceLocal(id: string, pick: number | string | RoundPick[] | ProtoAnswer | ChecklistAnswer, extra = '') {
  const result: ToolResult = Array.isArray(pick) ? { error: null, round: pick, ...(extra ? { roundExtra: extra } : {}) } : typeof pick === 'string' ? { error: null, choice: null, answer: pick }
    : typeof pick === 'object' ? ('ticked' in pick ? { error: null, checklist: pick } : { error: null, proto: pick }) : { error: null, choice: pick };
  useStore.setState((s) => {
    const cur = s.items[id];
    if (cur?.kind !== 'rich' || cur.result) return s;
    const d = new Draft(s);
    d.put(id, { ...cur, result });
    return d.done();
  });
}

// Recaps the user closed stay closed, even when their clip arrives later.
const closedRecaps = new Set<string>();
export function dismissRecap(id: string) {
  closedRecaps.add(id);
  if (closedRecaps.size > 200) closedRecaps.delete(closedRecaps.values().next().value!);
  useStore.setState((s) => ({ recaps: s.recaps.filter((r) => r.id !== id) }));
}

export function openReplay(view: ReplayView | null) {
  useStore.setState({ replayView: view });
}

export const isAsk = (it: Item) =>
  (it.kind === 'permission' && it.answer === null) ||
  (it.kind === 'rich' && (it.detail.kind === 'choice' || it.detail.kind === 'round' || it.detail.kind === 'upload' || it.detail.kind === 'prototype' || it.detail.kind === 'checklist') && !it.partial && !it.result);

// Copy-on-write view of the conversation: items, order and cardsOf are copied once, on the first write, however many events run.
class Draft {
  order: string[];
  items: Record<string, Item>;
  cardsOf: Record<string, CardRef[]>;
  status: Status;
  lastSeq: number;
  asks: number;
  lastPlan: string | null;
  older: number | null;
  orphans: SeqEvent[];
  streaming: string | null;
  // The seq of the event being applied; 0 for local changes, which keep the stamps they carry.
  seq = 0;
  private owned = { order: false, items: false, cards: false, orphans: false };

  constructor(c: Omit<Conv, 'loading'>) {
    this.order = c.order;
    this.items = c.items;
    this.cardsOf = c.cardsOf;
    this.status = c.status;
    this.lastSeq = c.lastSeq;
    this.asks = c.asks;
    this.lastPlan = c.lastPlan;
    this.older = c.older;
    this.orphans = c.orphans;
    this.streaming = c.streaming;
  }

  // An event about an item that may sit in history not loaded yet; with the whole history here it is just stale.
  orphan(e: SeqEvent) {
    if (this.older === null) return;
    if (!this.owned.orphans) (this.orphans = [...this.orphans]), (this.owned.orphans = true);
    this.orphans.push(e);
    if (this.orphans.length > ORPHANS_MAX) this.orphans.shift();
  }

  private ownItems() {
    if (!this.owned.items) (this.items = { ...this.items }), (this.owned.items = true);
    return this.items;
  }

  private ownOrder() {
    if (!this.owned.order) (this.order = [...this.order]), (this.owned.order = true);
    return this.order;
  }

  put(key: string, item: Item) {
    const prev = this.items[key];
    this.asks += Number(isAsk(item)) - Number(!!prev && isAsk(prev));
    if (!prev && item.kind === 'rich' && item.detail.kind === 'plan') this.lastPlan = key;
    // Every put gets a fresh object, so stamping it in place is safe.
    if (this.seq) {
      item.born = prev?.born ?? this.seq;
      item.touched = this.seq;
    }
    this.ownItems()[key] = item;
  }

  drop(key: string) {
    const prev = this.items[key];
    if (!prev) return;
    if (isAsk(prev)) this.asks--;
    delete this.ownItems()[key];
  }

  insert(at: number, key: string) {
    this.ownOrder().splice(at, 0, key);
  }

  unlist(key: string) {
    const i = this.order.lastIndexOf(key);
    if (i >= 0) this.ownOrder().splice(i, 1);
  }

  // Anything the user sends answers the quiet notices of the turns before it.
  quietDone() {
    for (let i = this.order.length - 1, n = 0; i >= 0 && n < QUIET_SCAN; i--, n++) {
      const it = this.items[this.order[i]];
      if (it?.kind === 'user') return;
      if (it?.kind === 'quiet' && !it.done) this.put(it.id, { ...it, done: true });
    }
  }

  setCards(owner: string, list: CardRef[]) {
    if (!this.owned.cards) (this.cardsOf = { ...this.cardsOf }), (this.owned.cards = true);
    this.cardsOf[owner] = list;
  }

  // Where a new item goes: above a turn's change cards, so they stay at the end of their turn. A prompt or update header opens a new turn.
  slot(item: Item) {
    const n = this.order.length;
    return item.kind !== 'user' && item.kind !== 'update' && n && this.items[this.order[n - 1]]?.kind === 'changes' ? n - 1 : n;
  }

  add(item: Item, key = item.id) {
    // Any new row ends the reply being written, except a message queued while it streams.
    if (item.kind === 'agent') this.streaming = key;
    else if (item.kind !== 'user' || !item.queued) this.streaming = null;
    this.insert(this.slot(item), key);
    this.put(key, item);
  }

  // A plain tool joins the group at the end of the conversation, or starts one.
  addTool(item: ToolItem, time?: number) {
    this.streaming = null;
    const at = this.slot(item);
    const last = at ? this.items[this.order[at - 1]] : undefined;
    if (last?.kind === 'group') {
      this.put(item.id, { ...item, group: last.id });
      this.put(last.id, { ...last, tools: [...last.tools, item.id] });
      return;
    }
    const group: Item = { kind: 'group', id: `g:${item.id}`, tools: [item.id], ...(time ? { at: time } : {}) };
    this.insert(at, group.id);
    this.put(group.id, group);
    this.put(item.id, { ...item, group: group.id });
  }

  // A call's change renews its group object too, so the group row re-renders.
  putTool(item: ToolItem) {
    this.put(item.id, item);
    const g = item.group ? this.items[item.group] : undefined;
    if (g?.kind === 'group') this.put(g.id, { ...g });
  }

  // A permission card takes the tool out of its group, so it is never hidden in a folded list.
  ungroup(id: string) {
    const t = this.items[id];
    const g = t?.kind === 'tool' && t.group ? this.items[t.group] : undefined;
    if (g?.kind === 'group') {
      const tools = g.tools.filter((x) => x !== id);
      if (tools.length) this.put(g.id, { ...g, tools });
      else {
        this.drop(g.id);
        this.unlist(g.id);
      }
    }
    this.drop(id);
  }

  done(): Omit<Conv, 'loading'> {
    return {
      order: this.order, items: this.items, cardsOf: this.cardsOf, status: this.status, lastSeq: this.lastSeq, asks: this.asks, lastPlan: this.lastPlan, older: this.older, orphans: this.orphans,
      streaming: this.streaming,
    };
  }
}

// Permission cards of rich calls live under their own key, so the frame stays.
const permKey = (d: Draft, id: string) => (d.items[id]?.kind === 'permission' ? id : `perm:${id}`);

// Only the touched item gets a new object, so only its row re-renders.
function apply(d: Draft, e: SeqEvent) {
  d.seq = e.seq;
  switch (e.type) {
    case 'user':
      d.quietDone();
      return d.add({ kind: 'user', id: e.id, text: e.text, ...(e.pastes?.length ? { pastes: e.pastes } : {}), ...(e.files?.length ? { files: e.files } : {}), ...(e.links?.length ? { links: e.links } : {}), ...(e.queued ? { queued: true } : {}), ...(e.stopped ? { stopped: true } : {}), ...(e.phone ? { phone: true } : {}), ...(e.at ? { at: e.at } : {}) });
    case 'wake':
      if (!d.items[e.id]) d.add({ kind: 'update', id: e.id, from: e.from, ...(e.at ? { at: e.at } : {}) });
      return;
    case 'quiet':
      for (const h of e.hide ?? []) {
        if (d.items[h]?.kind !== 'agent') continue;
        d.drop(h);
        d.unlist(h);
      }
      if (!d.items[e.id]) d.add({ kind: 'quiet', id: e.id, ...(e.at ? { at: e.at } : {}) });
      return;
    case 'delivered': {
      const cur = d.items[e.id];
      if (cur?.kind === 'user' && cur.queued) d.put(e.id, { ...cur, queued: false });
      else if (!cur) d.orphan(e);
      return;
    }
    case 'unqueued':
      if (d.items[e.id]?.kind !== 'user') return;
      d.drop(e.id);
      d.unlist(e.id);
      return;
    case 'text': {
      const cur = d.items[e.id];
      if (cur?.kind === 'agent') {
        d.put(e.id, { ...cur, text: cur.text + e.delta });
        d.streaming = e.id;
      } else d.add({ kind: 'agent', id: e.id, text: e.delta, ...(e.at ? { at: e.at } : {}) });
      return;
    }
    case 'tool': {
      const cur = d.items[e.id];
      if (e.fold) {
        const target = d.items[e.fold];
        if (target?.kind === 'rich') d.put(e.fold, { ...target, seen: true });
        else if (!target) d.orphan(e);
        return;
      }
      if (e.replaces) {
        const old = d.items[e.replaces];
        if (old?.kind === 'rich') d.put(e.replaces, { ...old, replaced: true });
        else if (!old) d.orphan(e);
      }
      if (e.detail && e.detail.kind !== 'diff') {
        const item: RichItem = { kind: 'rich', id: e.id, name: e.name, detail: e.detail, partial: !!e.partial, result: null, seen: false, ...(e.at ? { at: e.at } : {}) };
        if (cur?.kind === 'rich') d.put(e.id, { ...item, result: cur.result, seen: cur.seen, ...(cur.at ? { at: cur.at } : {}) });
        else if (!cur) d.add(item);
        return;
      }
      // A permission card for this call may already hold its place.
      if (!cur) d.addTool({ kind: 'tool', id: e.id, name: e.name, verb: e.verb, summary: e.summary, diff: e.detail?.kind === 'diff' ? e.detail : null, result: null, ...(e.desc ? { desc: e.desc } : {}) }, e.at);
      return;
    }
    case 'tool-result': {
      const cur = d.items[e.id];
      const result = { error: e.error, choice: e.choice, answer: e.answer, round: e.round, roundExtra: e.roundExtra, proto: e.proto, checklist: e.checklist, png: e.png, img: e.img, images: e.images, ms: e.ms, brief: e.brief, video: e.video, uploads: e.uploads, pagePngs: e.pagePngs };
      if (cur?.kind === 'tool') d.putTool({ ...cur, result });
      else if (cur?.kind === 'rich') d.put(e.id, { ...cur, result });
      else if (!cur) d.orphan(e);
      return;
    }
    case 'permission': {
      const item: Item = {
        kind: 'permission', id: e.id, tool: e.tool, summary: e.summary, ...(e.command ? { command: e.command } : {}), title: e.title, defaultToNo: e.defaultToNo, answer: null, detail: e.detail,
        questions: e.questions, plan: e.plan, back: e.back, ...(e.always ? { always: true } : {}),
      };
      const cur = d.items[e.id];
      if (cur?.kind === 'permission') d.put(e.id, item);
      else if (cur?.kind === 'rich') d.add(item, `perm:${e.id}`);
      else {
        if (cur?.kind === 'tool') d.ungroup(e.id);
        d.add(item);
      }
      return;
    }
    case 'permission-resolved': {
      const key = permKey(d, e.id);
      const cur = d.items[key];
      if (cur?.kind === 'permission') d.put(key, { ...cur, answer: e.allow, reply: e.reply, ...(e.elsewhere ? { elsewhere: true } : {}), ...(e.cancelled ? { cancelled: true } : {}) });
      else if (!cur) d.orphan(e);
      return;
    }
    case 'status':
      d.status = e.state;
      if (e.state !== 'working') d.streaming = null;
      return;
    case 'error':
      return d.add({ kind: 'error', id: `err-${e.seq}`, message: e.message });
    case 'tldr': {
      const cur = d.items[e.id];
      if (cur?.kind === 'agent') d.put(e.id, { ...cur, tldr: { text: e.text, words: e.words } });
      else if (!cur) d.orphan(e);
      return;
    }
    case 'tool-note': {
      const cur = d.items[e.id];
      if (cur?.kind === 'tool') d.putTool({ ...cur, note: e.text });
      else if (!cur) d.orphan(e);
      return;
    }
    // A turn that ended badly with the prompt still last on screen was stopped before any answer.
    case 'turn-end': {
      d.streaming = null;
      const id = d.order[d.order.length - 1];
      const cur = id ? d.items[id] : null;
      if (!e.ok && cur?.kind === 'user' && !cur.queued) d.put(id, { ...cur, stopped: true });
      return;
    }
    case 'changes': {
      const { type: _t, seq: _q, sessionId, ...card } = e;
      dropDiffs(sessionId, card.id);
      const key = `chg:${card.turn}`;
      const cur = d.items[key];
      if (cur?.kind !== 'changes') {
        if (!card.files.length) return;
        d.insert(d.order.length, key);
        d.put(key, { kind: 'changes', id: key, cards: [card] });
      } else {
        const has = cur.cards.some((c) => c.id === card.id);
        d.put(key, { ...cur, cards: has ? cur.cards.map((c) => (c.id === card.id ? card : c)) : [...cur.cards, card] });
      }
      const list = d.cardsOf[card.owner] ?? [];
      const i = list.findIndex(([, c]) => c.id === card.id);
      d.setCards(card.owner, i < 0 ? [...list, [key, card]] : list.with(i, [key, card]));
      return;
    }
  }
}

// The same reducer for a conversation kept outside this store (session widgets); replace starts from empty.
export function foldConv(c: Conv | null, events: SeqEvent[], replace = false): Conv {
  const d = new Draft(c && !replace ? c : emptyConv());
  for (const e of events) apply(d, e);
  return { ...d.done(), loading: false };
}

// An older page goes above what is loaded, then replays the orphans that point into it. A reply split by the cut
// is joined, and the page's last tool list merges into the first loaded one (keeping the loaded id).
function prepend(c: Conv, events: SeqEvent[], older: number | null): Partial<Conv> {
  const p = new Draft({ ...emptyConv(), older });
  for (const e of events) apply(p, e);
  // A prompt already loaded below answers this page's quiet notices.
  if (c.order.some((k) => c.items[k]?.kind === 'user')) {
    for (const k of p.order) {
      const it = p.items[k];
      if (it?.kind === 'quiet' && !it.done) p.put(k, { ...it, done: true });
    }
  }
  const left: SeqEvent[] = [];
  for (const e of c.orphans) {
    p.seq = e.seq;
    // A fold or replace points at an older card; its own card is already loaded, so only the mark is replayed.
    const ref = e.type === 'tool' ? (e.fold ?? e.replaces) : 'id' in e ? e.id : undefined;
    const target = ref ? p.items[ref] : undefined;
    if (e.type === 'tool') {
      if (target?.kind === 'rich') p.put(ref!, e.fold ? { ...target, seen: true } : { ...target, replaced: true });
      else left.push(e);
    } else if (ref && (target || p.items[`perm:${ref}`])) apply(p, e);
    else left.push(e);
  }
  const items = { ...p.items, ...c.items };
  const head: string[] = [];
  const joined = new Set<string>();
  for (const k of p.order) {
    const mine = p.items[k];
    const theirs = c.items[k];
    if (!theirs) head.push(k);
    else if (mine.kind === 'agent' && theirs.kind === 'agent') {
      items[k] = { ...theirs, text: mine.text + theirs.text, ...(mine.at ? { at: mine.at } : {}) };
      head.push(k);
      joined.add(k);
    }
  }
  const tail = joined.size ? c.order.filter((k) => !joined.has(k)) : c.order;
  const a = items[head[head.length - 1]];
  const b = items[tail[0]];
  if (a?.kind === 'group' && b?.kind === 'group') {
    items[b.id] = { ...b, tools: [...a.tools, ...b.tools], ...(a.at ? { at: a.at } : {}) };
    for (const t of a.tools) {
      const it = items[t];
      if (it?.kind === 'tool') items[t] = { ...it, group: b.id };
    }
    delete items[a.id];
    head.pop();
  }
  const cardsOf = { ...c.cardsOf };
  for (const [owner, list] of Object.entries(p.cardsOf)) cardsOf[owner] = [...list, ...(c.cardsOf[owner] ?? [])];
  return {
    order: [...head, ...tail], items, cardsOf, asks: c.asks + p.asks, lastPlan: c.lastPlan ?? p.lastPlan, older,
    orphans: [...p.orphans, ...left].slice(-ORPHANS_MAX),
  };
}

// The newest touch of a row, counting a group's calls; undefined when one is not stamped.
function touchOf(items: Record<string, Item>, it: Item) {
  let t = it.touched;
  if (it.kind === 'group') for (const id of it.tools) t = t === undefined ? t : Math.max(t, items[id]?.touched ?? Infinity);
  return t === Infinity ? undefined : t;
}

// Drops the rows above the last clean turn start at or above index `limit`, leaving the store as if only the rest had
// loaded; they come back through history-load. Never drops an open ask or the streaming row. True when rows went.
export function dropOlder(sessionId: string, limit: number) {
  const s = useStore.getState();
  if (s.current !== sessionId) return false;
  const { order, items } = s;
  let cut = 0;
  let newest = 0;
  for (let i = 0; i <= Math.min(limit, order.length - 1); i++) {
    const it = items[order[i]];
    if (i > 0 && it && (it.kind === 'user' || it.kind === 'update') && it.born !== undefined && newest < it.born) cut = i;
    const t = it && touchOf(items, it);
    if (t === undefined || isAsk(it) || order[i] === s.streaming) break;
    newest = Math.max(newest, t);
  }
  if (!cut) return false;
  const gone = new Set(order.slice(0, cut));
  const next = { ...items };
  for (const k of gone) {
    const it = items[k];
    if (it?.kind === 'group') for (const t of it.tools) delete next[t];
    delete next[k];
  }
  const cardsOf: Record<string, CardRef[]> = {};
  for (const [owner, list] of Object.entries(s.cardsOf)) {
    const kept = list.filter(([k]) => !gone.has(k));
    if (kept.length) cardsOf[owner] = kept;
  }
  const rest = order.slice(cut);
  let lastPlan = s.lastPlan;
  if (lastPlan && !next[lastPlan]) {
    lastPlan = null;
    for (let i = rest.length - 1; i >= 0 && !lastPlan; i--) {
      const it = next[rest[i]];
      if (it?.kind === 'rich' && it.detail.kind === 'plan') lastPlan = rest[i];
    }
  }
  const older = items[order[cut]].born!;
  // Orphans below the cut return with the next page; keeping them would apply them twice.
  const orphans = s.orphans.filter((e) => e.seq >= older);
  useStore.setState({ order: rest, items: next, cardsOf, lastPlan, older, orphans });
  return true;
}

// history and history-found replies, for whoever asked (the conversation window, Find).
type HistoryReply = Extract<ServerMessage, { type: 'history' | 'history-found' }>;
const historyWaiters = new Set<(msg: HistoryReply) => void>();
export function onHistory(fn: (msg: HistoryReply) => void) {
  historyWaiters.add(fn);
  return () => void historyWaiters.delete(fn);
}

// Notices that answer a request with no reply of its own (a reload, an upload answer); the same text may come twice.
const noticeWaiters = new Set<(message: string) => void>();
export function onNotice(fn: (message: string) => void) {
  noticeWaiters.add(fn);
  return () => void noticeWaiters.delete(fn);
}

// Answers for any other thread (an older panel) are dropped.
function reduceExplain(x: ExplainView | null, msg: ExplainEvent): ExplainView | null {
  if (!x || x.thread !== msg.thread) return x;
  switch (msg.type) {
    case 'explain-answer':
      if (msg.index !== x.turns.length) return x;
      return { ...x, status: 'ready', pending: '', turns: [...x.turns, { question: x.pending, text: msg.text, svg: null }] };
    case 'explain-drawing':
      return { ...x, turns: x.turns.map((t, i) => (i === msg.index ? { ...t, svg: msg.svg } : t)) };
    case 'explain-error':
      return msg.index === x.turns.length ? { ...x, status: 'error', pending: '', error: msg.error } : x;
  }
}

// A map patch carries only changed chapters, and the id order when it changed; untouched rows keep their objects.
function mergeChapters(prev: SessionMap['chapters'], rows: SessionMap['chapters'], order: string[] | undefined) {
  if (!rows.length && !order) return prev;
  const byId = new Map(prev.map((c) => [c.id, c]));
  for (const c of rows) byId.set(c.id, c);
  return order ? order.flatMap((id) => byId.get(id) ?? []) : prev.map((c) => byId.get(c.id)!);
}

// Storage can be blocked; bits.tsx's pref imports this store, so it is not used here.
// A literal key, not a const: the store's initializer calls savedOrder before this line runs.
function savedOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('cw:dockOrder') ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveOrder(order: string[]) {
  try {
    localStorage.setItem('cw:dockOrder', JSON.stringify(order));
  } catch {}
}

// New sessions join the end of the dock; closed ones leave it and the recent list.
function mergeDock(s: State, roster: SessionSummary[]): Pick<State, 'dockOrder' | 'recent'> {
  const ids = new Set(roster.map((r) => r.id));
  const kept = s.dockOrder.filter((d) => ids.has(d));
  const known = new Set(kept);
  const dockOrder = [...kept, ...roster.map((r) => r.id).filter((id) => !known.has(id))];
  // An empty roster only shows before the first list; saving it would lose the order.
  if (roster.length) saveOrder(dockOrder);
  return { dockOrder, recent: s.recent.filter((d) => ids.has(d) || d === s.current) };
}

// Open sessions in the reader's order; position + 1 is the session's number in the folder menu and for Ctrl/Alt+digit.
export function sessionOrder(s: Pick<State, 'roster' | 'dockOrder'>) {
  const ids = new Set(s.roster.map((r) => r.id));
  return s.dockOrder.filter((id) => ids.has(id));
}

// Drag-to-reorder: puts id right before or after another open session.
export function moveSession(id: string, to: string, after: boolean) {
  useStore.setState((s) => {
    const rest = s.dockOrder.filter((d) => d !== id);
    const i = rest.indexOf(to);
    if (i < 0 || id === to) return s;
    const dockOrder = rest.toSpliced(i + Number(after), 0, id);
    saveOrder(dockOrder);
    return { dockOrder };
  });
}

// Unchanged sessions keep their old objects, so a roster broadcast re-renders only what changed.
function shareRoster(old: SessionSummary[], next: SessionSummary[]) {
  const was = new Map(old.map((r) => [r.id, r]));
  const roster = next.map((r) => {
    const o = was.get(r.id);
    return o && JSON.stringify(o) === JSON.stringify(r) ? o : r;
  });
  return roster.length === old.length && roster.every((r, i) => r === old[i]) ? old : roster;
}

// A closed session's snapshots, menus, replays and diffs go with it.
function pruneClosed(s: State, roster: SessionSummary[]): Partial<State> {
  const keep = new Set(roster.map((r) => r.id));
  if (s.current) keep.add(s.current);
  const gone = (id: string) => !keep.has(id);
  const closed = new Set([...Object.keys(s.panels), ...Object.keys(s.maps), ...Object.keys(s.commands), ...Object.keys(s.mcpLists), ...Object.keys(s.settingsPending)].filter(gone));
  for (const k of [...Object.keys(s.replays), ...Object.keys(s.replayVoices)]) if (gone(k.slice(0, k.indexOf(':')))) closed.add(k.slice(0, k.indexOf(':')));
  if (!closed.size) return {};
  for (const id of closed) dropSessionDiffs(id);
  const strip = <T,>(rec: Record<string, T>, sid: (k: string) => string) => Object.fromEntries(Object.entries(rec).filter(([k]) => !closed.has(sid(k))));
  const self = (k: string) => k;
  const head = (k: string) => k.slice(0, k.indexOf(':'));
  return {
    panels: strip(s.panels, self), panelIdx: strip(s.panelIdx, self), maps: strip(s.maps, self), commands: strip(s.commands, self), mcpLists: strip(s.mcpLists, self), settingsPending: strip(s.settingsPending, self),
    replays: strip(s.replays, head), replayVoices: strip(s.replayVoices, head),
  };
}

// Returns the session to subscribe to when the server answered "opened".
export function applyMessage(msg: ServerMessage): string | void {
  switch (msg.type) {
    case 'hello':
      useStore.setState((s) => {
        // A reconnect to the same server keeps defaults the user picked in the menus since.
        const defaults = msg.serverId === s.serverId ? s.defaults : msg.defaults;
        // A session switch also sends hello; only a new server drops the pending changes (a socket close does too).
        const settingsPending = msg.serverId === s.serverId ? s.settingsPending : {};
        if (msg.sessionId !== s.current) return { serverId: msg.serverId, connected: true, defaults, settingsPending };
        if (msg.reset) convCache.clear();
        const conv = !msg.found ? emptyConv() : msg.reset ? emptyConv(true) : {};
        return { ...conv, serverId: msg.serverId, connected: true, defaults, settingsPending, ...(msg.found ? {} : { current: null }) };
      });
      return;
    case 'sessions':
      useStore.setState((s) => {
        const pend = s.settingsPending;
        const open = Object.keys(pend).length ? msg.open.map((r) => withPending(r, pend[r.id])) : msg.open;
        const roster = shareRoster(s.roster, open);
        if (roster === s.roster) return s;
        return { roster, ...mergeDock(s, roster), ...pruneClosed(s, roster) };
      });
      return;
    case 'settings-result':
      useStore.setState((s) => {
        const { [msg.sessionId]: list = [], ...rest } = s.settingsPending;
        const left = list.filter((p) => p.req !== msg.req);
        const roster = s.roster.map((r) => (r.id === msg.sessionId ? withPending({ ...r, ...msg.settings }, left) : r));
        return {
          roster, settingsPending: left.length ? { ...rest, [msg.sessionId]: left } : rest,
          ...(msg.error ? { notice: msg.error, noticeInfo: false } : {}),
        };
      });
      return;
    case 'past':
      useStore.setState({ past: msg.sessions, folders: msg.folders, home: msg.home });
      return;
    case 'notice':
      // A failed open or resume answers with an error notice, which ends its pending state.
      useStore.setState({ notice: msg.message, noticeInfo: msg.tone === 'info', ...(msg.tone === 'info' ? {} : { pendingOpen: null }) });
      for (const fn of noticeWaiters) fn(msg.message);
      return;
    case 'opened':
      useStore.setState({ palette: null, notice: null, pendingOpen: null });
      return msg.sessionId;
    case 'panel': {
      const { type: _t, sessionId, ...patch } = msg;
      useStore.setState((s) => {
        const prev = s.panels[sessionId];
        const panel = mergePanel(sessionId, prev, patch);
        const same = prev?.agents === panel.agents && prev.procs === panel.procs;
        const idx = same && s.panelIdx[sessionId] ? s.panelIdx[sessionId] : {
          agents: Object.fromEntries(panel.agents.map((a) => [a.id, a.state])),
          procs: Object.fromEntries(panel.procs.flatMap((p) => (p.tool ? [[p.tool, p.state]] : []))),
        };
        return { panels: { ...s.panels, [sessionId]: panel }, panelIdx: { ...s.panelIdx, [sessionId]: idx } };
      });
      return;
    }
    case 'agent-detail':
      putAgentText(msg.sessionId, msg.id, msg.detail);
      return;
    case 'map': {
      const { type: _t, sessionId, full, chapterOrder, ...map } = msg;
      // The map follows the backlog, so a session with no history stops loading here.
      useStore.setState((s) => {
        const prev = s.maps[sessionId];
        const next = full || !prev ? map : { ...map, chapters: mergeChapters(prev.chapters, map.chapters, chapterOrder) };
        return { maps: { ...s.maps, [sessionId]: next }, ...(s.loading && sessionId === s.current ? { loading: false } : {}) };
      });
      return;
    }
    case 'limits':
      useStore.setState({ limits: msg.limits });
      return;
    case 'replay': {
      const { type: _t, sessionId, id, ...info } = msg;
      useStore.setState((s) => ({ replays: { ...s.replays, [`${sessionId}:${id}`]: info } }));
      return;
    }
    case 'voice-on':
      useStore.setState({ voiceOn: msg.on });
      return;
    case 'replay-voice': {
      const { type: _t, ...v } = msg;
      const key = `${v.sessionId}:${v.id}`;
      useStore.setState((s) => {
        if (v.state !== 'dropped') return { replayVoices: { ...s.replayVoices, [key]: v } };
        const { [key]: _gone, ...rest } = s.replayVoices;
        return { replayVoices: rest };
      });
      return;
    }
    // Handled in setup.ts and update.ts.
    case 'connect-status':
    case 'login':
    case 'settings':
    case 'update':
    case 'codex-status':
    case 'codex-login':
    case 'codex-models':
    // Handled in socket.ts.
    case 'perf':
    case 'machine':
      return;
    case 'voice': {
      const { type: _t, ...r } = msg;
      useStore.setState((s) => {
        if (r.state === 'dropped' || closedRecaps.has(r.id)) return { recaps: s.recaps.filter((x) => x.id !== r.id) };
        // A new recap for a session replaces its old one; a ready one keeps its place in line.
        if (s.recaps.some((x) => x.id === r.id)) return { recaps: s.recaps.map((x) => (x.id === r.id ? r : x)) };
        return { recaps: [...s.recaps.filter((x) => x.sessionId !== r.sessionId), r] };
      });
      return;
    }
    case 'explain-answer':
    case 'explain-drawing':
    case 'explain-error':
      useStore.setState((s) => ({ explain: reduceExplain(s.explain, msg) }));
      return;
    case 'proc-log':
      useStore.setState((s) => {
        const log = s.log;
        if (log?.sessionId !== msg.sessionId || log.taskId !== msg.taskId) return s;
        // A reply sent before the user picked another source.
        if (log.pick && msg.shown !== log.pick && msg.sources.some((x) => x.key === log.pick)) return s;
        const body = msg.text !== undefined ? { text: msg.text, truncated: !!msg.truncated, source: msg.source, path: msg.path } : {};
        return { log: { ...log, ...body, sources: msg.sources, shown: msg.shown, quiet: msg.quiet && { at: Date.now() - msg.quiet.ms, exact: msg.quiet.exact } } };
      });
      return;
    case 'changes-detail':
      putDiff(msg.sessionId, msg.id, msg.path, msg.diff);
      return;
    case 'changes-reverted':
      putReverted(msg.sessionId, msg.req, msg.error, msg.undo);
      return;
    case 'changes-indexed':
      putIndex(msg.sessionId, msg.req, msg.files);
      return;
    case 'changes-context-lines':
      if (msg.lines) putGaps(msg.sessionId, msg.id, msg.path, msg.from, msg.lines);
      return;
    case 'commands':
      useStore.setState((s) => ({ commands: { ...s.commands, [msg.sessionId]: msg.commands }, ...(msg.commands.length ? { lastCommands: msg.commands } : {}) }));
      return;
    case 'mcp':
      useStore.setState((s) => {
        // A sign-in ends once its server stops needing one.
        const auth = { ...s.mcpLists[msg.sessionId]?.auth };
        for (const k of Object.keys(auth)) {
          const row = msg.servers.find((r) => r.key === k);
          if (auth[k].step !== 'opening' && (!row || row.state !== 'needs-auth')) delete auth[k];
        }
        return { mcpLists: { ...s.mcpLists, [msg.sessionId]: { servers: msg.servers, live: msg.live, phase: msg.phase, error: msg.error, auth } } };
      });
      return;
    case 'mcp-auth': {
      const prev = useStore.getState().mcpLists[msg.sessionId]?.auth?.[msg.server];
      const row = useStore.getState().mcpLists[msg.sessionId]?.servers.find((r) => r.key === msg.server);
      if (msg.checked) {
        // The list came first, so a row still needing sign-in means the user has not finished.
        if (row?.state === 'needs-auth') setMcpAuth(msg.sessionId, msg.server, { ...prev, step: 'waiting', error: msg.error ?? 'Not signed in yet' });
        else setMcpAuth(msg.sessionId, msg.server, null);
      } else if (msg.error) setMcpAuth(msg.sessionId, msg.server, { step: 'waiting', error: msg.error });
      else if (msg.url) setMcpAuth(msg.sessionId, msg.server, { step: 'waiting', url: msg.url, manual: msg.manual });
      else setMcpAuth(msg.sessionId, msg.server, null);
      return;
    }
    // Answered by the socket before it gets here.
    case 'ui-prompt':
    case 'bye':
    case 'pong':
    case 'stt':
    case 'voice-line':
    case 'skills':
    case 'skills-suggested':
    case 'skills-organize-progress':
    case 'skills-organized':
    case 'peek-events':
    case 'mentions':
      return;
    case 'found':
      useStore.setState({ found: { query: msg.query, dirs: msg.dirs } });
      return;
    case 'search-found':
      useStore.setState({ searched: { query: msg.query, cwd: msg.cwd, hits: msg.hits, indexing: msg.indexing } });
      return;
    case 'search-ai-found': {
      // An answer for a question the palette no longer shows is dropped.
      const a = useStore.getState().aiSearch;
      if (a?.query === msg.query && a.cwd === msg.cwd) useStore.setState({ aiSearch: { ...a, pending: false, hits: msg.hits, error: msg.error } });
      return;
    }
    case 'dirs':
      useStore.setState((s) => {
        const { [msg.path]: _, ...dirs } = s.dirs;
        const keys = Object.keys(dirs);
        for (const k of keys.slice(0, Math.max(0, keys.length - DIRS_MAX + 1))) delete dirs[k];
        return { dirs: { ...dirs, [msg.path]: 'error' in msg ? { error: msg.error } : { branch: msg.branch, dirs: msg.dirs } } };
      });
      return;
    case 'tree':
    case 'tree-file':
    case 'tree-found':
      applyTree(msg);
      return;
    // Watch mode keeps the timeline in its own model, outside React state.
    case 'watch-timeline':
    case 'watch-subs':
      deliverTimeline(msg);
      return;
    case 'agent-activity':
      putAgentActivity(msg);
      return;
    // The backlog runs through the reducer in one pass and one render; older servers send it event by event.
    case 'events':
      useStore.setState((s) => {
        if (msg.sessionId !== s.current) return s;
        const d = new Draft(msg.replace ? { ...emptyConv(), older: msg.older ?? null } : s);
        for (const e of msg.events) {
          if (e.seq <= d.lastSeq) continue;
          apply(d, e);
          d.lastSeq = e.seq;
        }
        if (msg.status) d.status = msg.status;
        if (d.status !== 'working') d.streaming = null;
        return { ...d.done(), loading: false };
      });
      return;
    case 'history':
      useStore.setState((s) => (msg.sessionId !== s.current || s.older !== msg.before || msg.error ? s : prepend(s, msg.events, msg.older)));
      for (const fn of historyWaiters) fn(msg);
      return;
    case 'history-found':
      for (const fn of historyWaiters) fn(msg);
      return;
    // socket.ts hands it to toolOutput.ts first, the terminal ones to terminal.ts, the folder ones to folderOpen.ts.
    case 'tool-output':
    case 'terminal':
    case 'terminal-hooks':
    case 'terminal-hooks-preview':
    case 'folder-menu':
    case 'open-folder':
      return;
    default:
      useStore.setState((s) => {
        if (msg.sessionId !== s.current || msg.seq <= s.lastSeq) return s;
        const d = new Draft(s);
        apply(d, msg);
        d.lastSeq = msg.seq;
        return d.done();
      });
  }
}

// Sending from the composer pins the conversation to the bottom, even when the echo lands mid-stream.
const followers = new Set<() => void>();
export function onSent(fn: () => void) {
  followers.add(fn);
  return () => void followers.delete(fn);
}
export function sent() {
  for (const fn of followers) fn();
}
