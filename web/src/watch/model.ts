import {
  checkOf, firstSentence, goalOf,
  type AgentRow, type AgentState, type CheckKind, type PlanSpec, type WatchEntry, type WatchSub, type WatchSubsMessage, type WatchTimelineMessage,
} from '../../../server/protocol.ts';
import { useStore, type Item } from '../store.ts';
import { send } from '../socket.ts';
import { fromServer, onTimeline, stampOf, wallNow } from './open.ts';
import { legDur, legsFor, widen, type Leg } from './director.ts';
import { RISE, laneEnd, type Lane } from './lanes.ts';
import { addAct, addBox, addCard, freeze, newStory, reach, type Story } from './story.ts';

// Watch mode's index of the current session: stations along the floor, the rows built at each one, and the beats
// that drive the robot. Built from the server's timeline of the whole transcript, then fed by the live store tail.

// The view runs this far behind real time, so a walk can start before the work it walks to.
export const LAG = 2.5;

export type Act = 'read' | 'search' | 'edit' | 'run' | 'think' | 'needs' | 'fault';
export type Phase = 'explore' | 'build' | 'check';
export type RowKind = 'file' | 'search' | 'run' | 'agent' | 'rich' | 'needs' | 'fault' | 'other';
export type Row = {
  key: string; kind: RowKind; label: string;
  // View times: when the row appears, when a read file was first edited, the latest call, the outcome (a run's
  // result, a question answered, an error recovered from).
  t: number; tEdit: number | null; tLast: number; res: number | null;
  mode: 'read' | 'edited'; add: number; rm: number; created: boolean; err: boolean; n: number;
  // Wall seconds when it happened and when its outcome came, for real durations; how a question was resolved.
  w0: number; w1: number | null; ans: string;
  // Agents: the spawning tool_use id (the panel row's id) and how the transcript says it ended.
  aid: string; fin: AgentState | '';
  // Commands: the raw command line behind a described label, and a failed one's telling output line; what it checks.
  cmd: string; why: string; check: CheckKind | null;
};
// One call an agent made (main or a subagent), for lists that follow the playhead. label follows the row rules (a
// command's description first); path is set for file tools. w0/w1: wall seconds of the call and its outcome; t/res:
// the same as view times (res null until the outcome is known).
export type Action = {
  id: string; verb: string; label: string; cmd: string; path: string;
  w0: number; w1: number | null; t: number; res: number | null;
  err: boolean; why: string; add: number; rm: number; created: boolean; check: CheckKind | null;
};
// A line of an agent's own narration (its first sentence), or the main reply's objective line.
export type Say = { w: number; t: number; s: string };
// One agent's story, oldest first, keyed by 'main' or the spawning Agent tool_use id. Subagents' come from their
// transcripts, so history has them too. acts keeps the newest ACTS_MAIN/ACTS_SUB; more counts the ones dropped before.
// notes: progress calls it made; steps: one per action, which a lane walks when it reported no progress.
export type AgentLog = { aid: string; acts: Action[]; more: number; says: Say[]; notes: AgentNote[]; steps: AgentNote[] };
// A file an agent touched by a view time: how, the lines it changed and when (view times) it first and last did.
export type FileTouchAt = { path: string; mode: 'read' | 'edited'; add: number; rm: number; created: boolean; n: number; t0: number; t1: number };
// A check command and how it stands at a view time.
export type CheckAt = { kind: CheckKind; state: 'running' | 'ok' | 'failed'; label: string; aid: string; t: number };
// What happened between two wall times, for a catch-up summary.
export type CatchUp = {
  steps: Station[]; agents: { lane: Lane; fin: AgentState }[]; errors: Row[];
  files: { path: string; add: number; rm: number; by: string[] }[]; checks: CheckAt[]; actions: number;
};
// An agent card's facts at a view time: when it ended (view time), how, and the panel row when the server has one.
export type AgentEnd = { end: number | null; fin: AgentState; p: AgentRow | undefined };
// A running agent's step line and step count (d of n, -1 without steps) as the panel reported them at wall time w;
// i counts the agent's notes, so an open-ended lane takes one step per note even after old ones are dropped.
export type AgentNote = { w: number; s: string; d: number; n: number; i: number };
export type StationKind = 'start' | 'ask' | 'step' | 'phase';
export type Beat = { tv: number; row: Row | null };
export type Station = {
  id: number; kind: StationKind; label: string;
  // Plan step index (steps), and the plan it belongs to.
  num: number; plan: Plan | null; phase: Phase | null;
  // Session (model) times: became current, walk out of the previous station, arrival, first and last work, done.
  t0: number; dep: number; arr: number; first: number; last: number; done: number;
  // Built from the conversation on a synthetic clock, so its durations mean nothing.
  past: boolean;
  x: number; dist: number; base: number; baseLegs: Leg[]; tpl: number; legs: Leg[]; dur: number; depMin: number; passing: boolean;
  rows: Row[]; byPath: Map<string, Row>; more: number; tools: number; lastTv: number;
  dirs: Map<string, number>; cmds: string[];
  // The story tree of what each agent did here, drawn in place of the cell sculpture.
  story: Story;
  // Pulses he makes here, in time order; the questions and errors that get a card.
  beats: Beat[]; calls: Row[];
  // His narration before the work here, by the view time of the row that followed it; capped at SAYS_ST.
  says: Say[];
};
type Plan = { title: string; texts: string[]; st: Station[]; active: boolean };
type Mark = { t: number; act: Act; row?: Row };

// The model's log: the server's timeline, then live store items in the same shape. w and end are local wall seconds.
type Ev = {
  k: WatchEntry['k'] | 'rich' | 'status'; id: string; w: number; end?: number; err?: boolean;
  verb?: string; s?: string; desc?: string; why?: string; add?: number; rm?: number; created?: boolean; plan?: PlanSpec; on?: boolean;
  // How a resolved question reads; live tells allow from deny, the transcript cannot.
  ans?: string; live?: boolean; row?: Row; state?: AgentState;
  // Text: its objective line. Subagent entries: whose they are, and a note's steps done of total.
  goal?: string; aid?: string; d?: number; n?: number; act?: Action;
};

// Actions kept per agent log (the server sends a sub's newest SUB_KEEP = 200); narration lines per log and station; objectives.
const ACTS_MAIN = 4000;
const ACTS_SUB = 200;
const NOTES_MAX = 50;
const SAYS_MAX = 200;
const SAYS_ST = 8;
const GOALS_MAX = 200;
// Subagent entries held for rebuilds; ids kept to tell a settle from a new entry.
const SUBLOG_MAX = 24_000;
// Running subagents are polled this often; one ended this long ago has its whole transcript.
const POLL_MS = 1500;
const SETTLED_S = 20;
const ROWS_MAX = 40;
const BEATS_MAX = 160;
const CALLS_MAX = 16;
const AGENTS_MAX = 256;
// A column above his head holds two question or error cards.
const CARD_SLOTS = 2;
const STATIONS_MAX = 4000;
const MARKS_MAX = 40_000;
const LOG_MAX = 24_000;
const KNOWN_MAX = 4000;
// An auto phase splits only once it has this many tools and this many seconds.
const SPLIT_TOOLS = 3;
const SPLIT_SECS = 6;
// Fallback backlog, when no timeline comes: this many user turns back, at most this many conversation rows.
const BACK_TURNS = 3;
const BACK_ROWS = 400;
const WAIT_MS = 2500;
// History idle longer than this plays as this long; the scrubber marks each cut.
const GAP = 8;
// Seconds of floor before the first prompt.
const LEAD = 3;
const START_X = 200;
// Floor a station's cards need before the next station's title: one column, then each further column.
const CALL_SPAN = 770;
const COL_SPAN = 384;
// Floor between a station's tree and the next station, whose title starts left of it.
const TREE_GAP = 210;

const actOf = (verb: string): Act =>
  verb === 'read' || verb === 'fetch' ? 'read'
  : verb === 'search' || verb === 'web' ? 'search'
  : verb === 'edit' || verb === 'write' ? 'edit'
  : verb === 'run' || verb === 'background' ? 'run'
  : 'think';
const phaseOf = (verb: string): Phase | null =>
  verb === 'read' || verb === 'search' || verb === 'web' || verb === 'fetch' ? 'explore'
  : verb === 'edit' || verb === 'write' ? 'build'
  : verb === 'run' || verb === 'background' ? 'check'
  : null;
// "web/src/watch/model.ts" → "web/src/watch/"; the last two folders are enough to name a place.
const dirOf = (p: string) => {
  const parts = p.split('/');
  if (parts.length < 2) return p;
  return parts.slice(Math.max(0, parts.length - 3), -1).join('/') + '/';
};
const firstWords = (cmd: string) => cmd.replace(/^(cd [^&;]+(&&|;)\s*)+/, '').split(/\s+/).slice(0, 2).join(' ').slice(0, 26);
const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length;
const NAMES: Record<string, string> = { chart: 'Chart', table: 'Table', visual: 'Visual', replay: 'Replay', image: 'Image' };
// Calls that ask the user: their permission card is the row, so the call itself is not one.
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
// A command with no description reads better without its plumbing: redirects and a trailing head/tail.
const tidyCmd = (cmd: string) =>
  cmd.replace(/^(cd [^&;|]+(&&|;)\s*)+/, '').replace(/\s+[12]?>\s*\/dev\/null|\s+2>&1/g, '').replace(/(\s*\|\s*(head|tail)(\s+-n?\s*\d+|\s+-\d+)?\s*)+$/, '').trim() || cmd;
// What a failed live call says went wrong: the server's pick of its output, else the error itself.
const whyOf = (it: Extract<Item, { kind: 'tool' }>) => (it.result?.error != null ? it.result.brief || it.result.error : undefined);
const isFile = (verb: string) => verb === 'read' || verb === 'edit' || verb === 'write';
const isRun = (verb: string) => verb === 'run' || verb === 'background';
// A row's or action's label: a command's description first, else the tidied command; the path for file tools.
const labelOf = (verb: string, s: string, desc: string | undefined) =>
  isRun(verb) ? desc || tidyCmd(s) : isFile(verb) || verb === 'search' || verb === 'agent' ? s : `${verb} ${s}`.trim();
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;
// An action as a present-tense line: "Reading store.ts", a command's description, "Agent: Fix the build".
export function actionPhrase(a: Action) {
  switch (a.verb) {
    case 'read': return `Reading ${baseName(a.path)}`;
    case 'edit': return `Editing ${baseName(a.path)}`;
    case 'write': return `Writing ${baseName(a.path)}`;
    case 'search': return `Searching ${a.label}`;
    case 'agent': return `Agent: ${a.label}`;
    default: return a.label;
  }
}
// Index after the last entry at or before view time T, by binary search; entries are in time order.
export function upTo<X extends { t: number }>(a: readonly X[], T: number) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].t <= T) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const sayAt = (l: readonly Say[], T: number) => {
  const j = upTo(l, T);
  return j ? l[j - 1] : null;
};
// Pushes x and drops a batch from the front past max, so the splice cost is paid rarely; returns how many went.
function capped<T>(l: T[], x: T, max: number) {
  l.push(x);
  if (l.length <= max + 16) return 0;
  const k = l.length - max;
  l.splice(0, k);
  return k;
}

// Watch's only clock, in local wall seconds: an event's server `at` when it had one, else its arrival.
export const nowSec = wallNow;
export const eventTime = (seq: number | undefined) => (seq === undefined ? undefined : stampOf(seq)) ?? wallNow();

// Sorted insert for lists that are almost always appended to.
function ins<T extends { t: number }>(a: T[], x: T) {
  let i = a.length;
  while (i > 0 && a[i - 1].t > x.t) i--;
  a.splice(i, 0, x);
}

function fromEntry(e: WatchEntry, prev: number): Ev {
  const ev: Ev = { k: e.k, id: e.id, w: e.at !== null ? fromServer(e.at) : prev, err: !!e.err };
  if (e.end !== undefined) ev.end = fromServer(e.end);
  if (e.state !== undefined) ev.state = e.state;
  if (e.verb !== undefined) ev.verb = e.verb;
  if (e.s !== undefined) ev.s = e.s;
  if (e.desc) ev.desc = e.desc;
  if (e.why) ev.why = e.why;
  if (e.add !== undefined) (ev.add = e.add), (ev.rm = e.rm ?? 0), (ev.created = !!e.created);
  if (e.plan) ev.plan = e.plan;
  if (e.goal) ev.goal = e.goal;
  if (e.d !== undefined) (ev.d = e.d), (ev.n = e.n ?? 0);
  if (e.k === 'permission') ev.ans = e.verb?.includes('plan') ? (e.err ? 'Sent back' : 'Approved') : e.err ? 'Declined' : 'Answered';
  return ev;
}

export class WatchModel {
  stations: Station[] = [];
  // LED activity over time, and working/idle switches; both sorted by time.
  marks: Mark[] = [];
  runs: { t: number; on: boolean }[] = [];
  // Idle stretches cut out of history: past model time m, wall = origin + T + sum.
  cuts: { m: number; sum: number }[] = [];
  plan: Plan | null = null;
  cur: Station | null = null;
  // Local wall seconds at model time 0, and how much idle time the cuts removed.
  origin = 0;
  cutSum = 0;
  // Model time when watch opened, for a synthetic backlog; 0 when the history has real times.
  openT = 0;
  // 'wait': asked the server for the timeline. 'timeline': built from it. 'backlog': from the conversation on screen.
  source: 'wait' | 'timeline' | 'backlog' = 'wait';
  // Cursor for the next older timeline page; null once the session start is loaded.
  before: number | null = null;
  version = 0;
  viewNow: () => number = () => -Infinity;
  onChange: () => void = () => {};
  onClose: () => void = () => {};
  // After a rebuild: the wall time the view was showing, so it can stay on it.
  onRebuild: (wall: number) => void = () => {};
  // The agents panel changed: a card's state or last line may have too.
  onAgents: () => void = () => {};
  // Every agent's lane (its row, station, height slot and riser x), oldest first, so lanes never scan the floor.
  agents: Lane[] = [];
  // Each agent's own actions, narration and notes ('main' plus one per lane, capped at AGENTS_MAX); rebuilt with the model.
  logs = new Map<string, AgentLog>();
  // The main replies' objective lines, oldest first.
  goals: Say[] = [];
  // Stations show story trees (else cell sculptures), and the floor after each one makes room for its tree.
  tree: boolean;
  // The widest tree, so the view knows how far left a station can still reach into the screen.
  treeMax = 0;
  // Lanes by spawning tool_use id, so a subagent's actions find the station that started it.
  private laneBy = new Map<string, Lane>();
  sid: string;
  private pan: AgentRow[] | undefined;
  private panById = new Map<string, AgentRow>();
  private ends = new WeakMap<AgentRow, number>();
  // Each running agent's reported step and progress, by wall time, so a card replays them at the lagged view time.
  private alog = new Map<string, AgentNote[]>();
  private log: Ev[] = [];
  // Ids the timeline already holds, so the same call coming live is not counted twice.
  private ids = new Set<string>();
  private asking: number | null | undefined;
  private timer = 0;
  private sched = 0;
  private nextId = 0;
  private replaying = false;
  private compress = false;
  private lastW = 0;
  private known = new Set<string>();
  private groupSeen = new Map<string, number>();
  private pendingTools = new Map<string, Ev>();
  private pendingNeeds = new Map<string, Ev>();
  private pendingRich = new Set<string>();
  // History outcomes waiting for the replay to reach their time, sorted by end.
  private settles: Ev[] = [];
  private fault: Row | null = null;
  private status: string;
  private unsub: () => void = () => {};
  // Subagent transcript entries in wall-time order, merged into every build; by id, so a settle updates its entry.
  private subLog: Ev[] = [];
  private subEvs = new Map<string, Ev>();
  // Per subagent: the watch-subs cursor and the actions the server dropped before what it sent.
  private subRev = new Map<string, number>();
  private subMore = new Map<string, number>();
  // A poll in flight until this wall time.
  private polling = 0;
  private poller = 0;
  // Narration waiting for the next row to attach to its station; live texts whose first sentence is still streaming.
  private say: { w: number; s: string } | null = null;
  private pendingSay = new Map<string, Ev>();

  constructor(sid: string, tree = true) {
    this.sid = sid;
    this.tree = tree;
    const s = useStore.getState();
    this.status = s.status;
    this.note(s.panels[sid]?.agents);
    onTimeline((msg) => {
      if (msg.sessionId !== this.sid) return;
      if (msg.type === 'watch-subs') this.onSubs(msg);
      else this.onPage(msg);
    });
    this.request(undefined);
    this.timer = window.setTimeout(() => this.fallback(), WAIT_MS);
    this.poller = window.setInterval(() => this.poll(), POLL_MS);
    let prev = s;
    // Runs on every store change while watch is open; the work is proportional to the tail, never the conversation.
    this.unsub = useStore.subscribe((n) => {
      if (n.current !== this.sid) return this.onClose();
      const pa = n.panels[this.sid]?.agents;
      if (pa !== prev.panels[this.sid]?.agents) (this.note(pa), this.onAgents());
      if (n.order === prev.order && n.items === prev.items && n.status === prev.status) return void (prev = n);
      prev = n;
      if (this.source === 'wait') return;
      const w = eventTime(n.lastSeq);
      const a = this.tail(n.order, n.items, w);
      if (this.setStatus(n.status, w) || a) this.changed();
    });
  }

  dispose() {
    this.unsub();
    clearTimeout(this.timer);
    clearInterval(this.poller);
    onTimeline(null);
  }

  private changed() {
    this.version++;
    this.onChange();
  }

  // ---- Clock: model time is wall time since origin, minus the idle cut out of history. ----
  now() {
    return wallNow() - this.origin - this.cutSum;
  }

  wallOf(T: number) {
    const c = this.cuts;
    let lo = 0, hi = c.length - 1, k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].m <= T) (k = mid), (lo = mid + 1);
      else hi = mid - 1;
    }
    return this.origin + T + (k >= 0 ? c[k].sum : 0);
  }

  modelOf(w: number) {
    let s = 0;
    for (const c of this.cuts) {
      const T = w - this.origin - s;
      if (T < c.m) return T;
      if (w - this.origin - c.sum < c.m) return c.m;
      s = c.sum;
    }
    return w - this.origin - s;
  }

  private mt(w: number) {
    if (this.compress && w - this.lastW > GAP) {
      const d = w - this.lastW - GAP;
      this.cuts.push({ m: this.lastW - this.origin - this.cutSum + GAP / 2, sum: this.cutSum + d });
      this.cutSum += d;
    }
    if (w > this.lastW) this.lastW = w;
    return w - this.origin - this.cutSum;
  }

  // ---- Timeline pages ----
  private request(before: number | undefined) {
    if (this.asking !== undefined) return;
    if (send({ type: 'watch-load', sessionId: this.sid, ...(before !== undefined ? { before } : {}) })) this.asking = before ?? null;
  }

  // Asked for when the view reaches the oldest loaded moment.
  loadOlder() {
    if (this.source === 'timeline' && this.before !== null && this.log.length < LOG_MAX) this.request(this.before);
  }

  get loadingOlder() {
    return typeof this.asking === 'number';
  }

  private onPage(msg: WatchTimelineMessage) {
    if (msg.page !== this.asking) return;
    this.asking = undefined;
    if (msg.error && !msg.entries.length) return this.fallback();
    const page: Ev[] = [];
    let w = msg.entries[0]?.at != null ? fromServer(msg.entries[0].at) : wallNow();
    for (const e of msg.entries) page.push(fromEntry(e, w)), (w = page[page.length - 1].w);
    const subs = this.subEntries(msg.subs ?? []);
    if (msg.page === null) {
      this.subLog = subs;
      this.subEvs = new Map(subs.map((e) => [e.id, e]));
    } else if (subs.length) {
      const fresh = subs.filter((e) => !this.subEvs.has(e.id));
      for (const e of fresh) this.subEvs.set(e.id, e);
      this.subLog = [...fresh, ...this.subLog].sort((a, b) => a.w - b.w);
    }
    if (msg.page === null) {
      // The newest page replaces what was built; live items the transcript does not hold yet stay.
      this.ids = new Set(page.map((e) => e.id));
      const lastW = page.length ? page[page.length - 1].w : -Infinity;
      const live = this.log.filter((e) => e.live && !this.ids.has(e.id) && (e.k === 'tool' || e.k === 'permission' || e.k === 'plan' || e.w > lastW));
      this.log = [...page, ...live];
      if (this.source === 'wait') this.adopt();
      clearTimeout(this.timer);
      this.source = 'timeline';
    } else this.log = [...page, ...this.log];
    this.before = msg.before;
    this.rebuild();
  }

  // A page's subagent transcripts as log entries, sorted by wall time; remembers each one's cursor.
  private subEntries(subs: WatchSub[]) {
    const out: Ev[] = [];
    for (const sub of subs) {
      this.subRev.set(sub.aid, Math.max(sub.rev, this.subRev.get(sub.aid) ?? 0));
      if (!this.subMore.has(sub.aid)) this.subMore.set(sub.aid, sub.more);
      let w = sub.entries[0]?.at != null ? fromServer(sub.entries[0].at) : wallNow();
      for (const en of sub.entries) {
        const e = fromEntry(en, w);
        e.aid = sub.aid;
        out.push(e);
        w = e.w;
      }
    }
    while (this.subRev.size > AGENTS_MAX) this.subRev.delete(this.subRev.keys().next().value!);
    while (this.subMore.size > AGENTS_MAX) this.subMore.delete(this.subMore.keys().next().value!);
    return out.sort((a, b) => a.w - b.w);
  }

  // Asks for what running subagents did since the last answer; only their new or settled entries come back.
  private poll() {
    const now = wallNow();
    if (this.source !== 'timeline' || now < this.polling) return;
    const since: [string, number][] = [];
    for (let i = this.agents.length - 1; i >= 0 && since.length < 32; i--) {
      const r = this.agents[i].row, p = this.panelAgent(r.aid);
      if (!r.aid || p?.kind === 'codex') continue;
      const end = p && !p.main ? (p.endedAt ? fromServer(p.endedAt) : null) : r.w1;
      if (this.agentEnd(r).end !== null && (end === null || now - end > SETTLED_S)) continue;
      since.push([r.aid, this.subRev.get(r.aid) ?? 0]);
    }
    if (since.length && send({ type: 'watch-subs', sessionId: this.sid, since })) this.polling = now + 5;
  }

  private onSubs(msg: WatchSubsMessage) {
    this.polling = 0;
    if (this.source !== 'timeline' || !msg.subs.length) return;
    for (const sub of msg.subs) {
      this.subRev.set(sub.aid, sub.rev);
      if (!this.subMore.has(sub.aid)) this.subMore.set(sub.aid, sub.more);
      let w = wallNow();
      for (const en of sub.entries) {
        const old = this.subEvs.get(en.id);
        if (!old) {
          const e = fromEntry(en, w);
          e.aid = sub.aid;
          w = e.w;
          this.addSub(e);
          this.ingest(e, this.mt(e.w));
        } else if (en.end !== undefined && old.end === undefined) {
          old.end = fromServer(en.end);
          old.err = !!en.err;
          if (en.why) old.why = en.why;
          if (en.state) old.state = en.state;
          this.settle(old, this.mt(old.end));
        }
      }
    }
    this.version++;
    this.onAgents();
  }

  // Live entries arrive almost in order, so the sorted insert walks back a step or two.
  private addSub(e: Ev) {
    const l = this.subLog;
    let i = l.length;
    while (i > 0 && l[i - 1].w > e.w) i--;
    l.splice(i, 0, e);
    this.subEvs.set(e.id, e);
    if (l.length > SUBLOG_MAX + 1000) for (const x of l.splice(0, l.length - SUBLOG_MAX)) this.subEvs.delete(x.id);
  }

  // The store items already on screen when the timeline came: the ones the transcript lacks join the log.
  private adopt() {
    const { order, items, status } = useStore.getState();
    const lastUser = this.log.findLast((e) => e.k === 'user')?.s ?? '';
    const w = wallNow();
    for (let i = Math.max(0, order.length - 40); i < order.length; i++) {
      const key = order[i], it = items[key];
      if (!it) continue;
      this.remember(key);
      if (it.kind === 'group') {
        this.groupSeen.set(key, it.tools.length);
        for (const id of it.tools) {
          const t = items[id];
          if (t?.kind !== 'tool' || this.ids.has(t.id) || ASKS.has(t.name)) continue;
          const e = this.toolEv(t, w);
          if (t.result) (e.end = w), (e.err = t.result.error !== null);
          this.log.push(e);
        }
      } else if (it.kind === 'user' && !this.ids.has(it.id) && !lastUser.startsWith(flat(it.text).slice(0, 60))) {
        this.log.push({ k: 'user', id: it.id, w, s: it.text, live: true });
      } else if (it.kind === 'rich' && it.partial) {
        this.pendingRich.add(key);
      } else if ((it.kind === 'tool' || it.kind === 'permission' || it.kind === 'rich') && !this.ids.has(it.id)) {
        const e = this.itemEv(key, it, w);
        if (!e) continue;
        if (it.kind === 'permission' && it.answer !== null) (e.end = w), (e.err = !it.answer);
        if (it.kind !== 'permission' && it.result) (e.end = w), (e.err = it.result.error !== null);
        this.log.push(e);
      }
    }
    this.status = status;
  }

  // No timeline (an older server, an error, or no answer in time): the last few turns on a synthetic clock.
  private fallback() {
    if (this.source !== 'wait') return;
    clearTimeout(this.timer);
    this.source = 'backlog';
    const { order, items, status } = useStore.getState();
    let from = Math.max(0, order.length - BACK_ROWS);
    for (let i = order.length - 1, turns = 0; i >= from; i--) {
      if (items[order[i]]?.kind === 'user' && ++turns >= BACK_TURNS) {
        from = i;
        break;
      }
    }
    const log: Ev[] = [];
    let syn = 0;
    for (let i = from; i < order.length; i++) {
      const key = order[i], it = items[key];
      if (!it) continue;
      this.remember(key);
      syn += it.kind === 'user' ? 3 : 0.5;
      if (it.kind === 'group') {
        this.groupSeen.set(key, it.tools.length);
        for (const id of it.tools) {
          const t = items[id];
          if (t?.kind !== 'tool' || ASKS.has(t.name)) continue;
          const e = this.toolEv(t, syn);
          if (t.result) (e.end = syn + 0.4), (e.err = t.result.error !== null);
          log.push(e);
          syn += 0.5;
        }
        continue;
      }
      if (it.kind === 'rich' && it.partial) {
        this.pendingRich.add(key);
        continue;
      }
      const e = it.kind === 'user' ? ({ k: 'user', id: it.id, w: syn, s: it.text } as Ev) : this.itemEv(key, it, syn);
      if (!e) continue;
      // Outcomes already in the backlog land shortly after their call.
      if (it.kind === 'permission' && it.answer !== null) e.end = syn + 0.4;
      if ((it.kind === 'tool' || it.kind === 'rich') && it.result) (e.end = syn + 0.4), (e.err = it.result.error !== null);
      e.live = false;
      log.push(e);
    }
    this.status = status;
    this.reset();
    this.build(log, true);
    this.log = [];
    this.changed();
  }

  private rebuild() {
    const keep = this.version ? this.wallOf(this.viewNow()) : NaN;
    this.reset();
    this.build(this.log, false);
    this.changed();
    if (!Number.isNaN(keep)) this.onRebuild(keep);
  }

  private reset() {
    this.stations = [];
    this.marks = [];
    this.runs = [];
    this.cuts = [];
    this.plan = this.cur = this.fault = null;
    this.agents = [];
    this.laneBy.clear();
    this.treeMax = 0;
    this.logs = new Map();
    this.goals = [];
    this.say = null;
    this.ends = new WeakMap();
    this.cutSum = this.sched = this.nextId = 0;
    this.pendingTools.clear();
    this.pendingNeeds.clear();
    this.settles = [];
  }

  private build(log: Ev[], past: boolean) {
    this.replaying = true;
    const now = wallNow();
    this.compress = !past;
    const subs = past ? [] : this.subLog;
    const w0 = log.length ? log[0].w : now;
    this.origin = w0 - LEAD;
    this.lastW = w0;
    this.runs.push({ t: 0, on: false });
    this.addStart(0);
    // Subagent entries interleave by wall time, so their work also keeps idle cuts out of a background run.
    let j = 0;
    const take = (e: Ev) => {
      this.flush(e.w);
      this.ingest(e, this.mt(e.w));
    };
    for (const e of log) {
      while (j < subs.length && subs[j].w <= e.w) take(subs[j++]);
      take(e);
    }
    while (j < subs.length) take(subs[j++]);
    this.flush(Infinity);
    const working = this.status === 'working';
    if (past) {
      // The synthetic backlog has finished playing when watch opens; live time continues from there.
      let end = this.lastW - this.origin;
      for (const st of this.stations) end = Math.max(end, st.arr || 0, st.lastTv, st.done || 0);
      if (working) this.power(true, end);
      else if (this.cur && this.cur.kind !== 'start' && Number.isNaN(this.cur.done)) this.cur.done = end;
      this.openT = end + LAG;
      this.origin = now - LAG - this.openT;
    } else {
      // Long idle since the last entry is cut too, so the live edge sits just after the history.
      const t = this.mt(now);
      this.openT = 0;
      this.power(working, t);
    }
    this.compress = false;
    this.replaying = false;
  }

  private flush(w: number) {
    const q = this.settles;
    while (q.length && q[0].end! <= w) {
      const e = q.shift()!;
      this.settle(e, this.mt(e.end!));
    }
  }

  // ---- Live: new rows sit at the end of `order` (or one above the change cards); groups grow in place. ----
  private tail(order: string[], items: Record<string, Item>, w: number) {
    let hit = false;
    // Before new rows, so narration that just ended attaches to the row that ended it.
    for (const [key, e] of this.pendingSay) {
      const it = items[key];
      const done = !it || it.kind !== 'agent' || order[order.length - 1] !== key || this.status !== 'working';
      if (this.liveSay(e, it?.kind === 'agent' ? it.text : '', done, this.mt(w))) this.pendingSay.delete(key);
    }
    for (let i = Math.max(0, order.length - 4); i < order.length; i++) {
      const key = order[i];
      const it = items[key];
      if (it) hit = this.ingestKey(key, it, items, w) || hit;
    }
    for (const id of this.pendingRich) {
      const it = items[id];
      if (it?.kind === 'rich' && !it.partial) {
        this.pendingRich.delete(id);
        const e = this.itemEv(id, it, w);
        if (e) this.push(e);
        hit = true;
      }
    }
    for (const [id, e] of this.pendingTools) {
      const it = items[id];
      if ((it?.kind === 'tool' || it?.kind === 'rich') && it.result) {
        this.pendingTools.delete(id);
        if (it.kind === 'tool') e.why = whyOf(it);
        this.settleLive(e, w, it.result.error !== null);
        hit = true;
      }
    }
    for (const [id, e] of this.pendingNeeds) {
      const p = items[id], q = items[`perm:${id}`];
      const perm = p?.kind === 'permission' ? p : q?.kind === 'permission' ? q : null;
      const done = perm ? perm.answer !== null : (p?.kind === 'tool' || p?.kind === 'rich') && !!p.result;
      if (!done) continue;
      this.pendingNeeds.delete(id);
      if (perm) e.ans = e.verb === 'ask' ? 'Answered' : e.verb === 'plan' ? (perm.answer ? 'Approved' : 'Sent back') : perm.answer ? 'Allowed' : 'Denied';
      else e.ans = 'Answered';
      this.settleLive(e, w, perm?.answer === false);
      hit = true;
    }
    return hit;
  }

  private setStatus(status: string, w: number) {
    if (status === this.status) return false;
    this.status = status;
    this.push({ k: 'status', id: '', w, on: status === 'working', live: true });
    return true;
  }

  private push(e: Ev) {
    e.live = true;
    this.log.push(e);
    if (this.log.length > LOG_MAX) this.log.splice(0, 2000);
    this.ingest(e, this.mt(e.w));
  }

  private settleLive(e: Ev, w: number, err: boolean) {
    e.end = w;
    e.err ||= err;
    this.settle(e, this.mt(w));
  }

  private remember(key: string) {
    this.known.add(key);
    if (this.known.size > KNOWN_MAX) this.known.delete(this.known.values().next().value!);
  }

  private toolEv(it: Extract<Item, { kind: 'tool' }>, w: number): Ev {
    const e: Ev = { k: it.verb === 'agent' ? 'agent' : 'tool', id: it.id, w, verb: it.verb, s: it.diff?.path ?? it.summary, live: true };
    if (it.desc) e.desc = it.desc;
    const why = whyOf(it);
    if (why) e.why = why;
    if (it.diff) (e.add = it.diff.add), (e.rm = it.diff.rm), (e.created = it.diff.created);
    else if (it.verb === 'write') e.created = true;
    return e;
  }

  // A store item as a log entry; null for what watch does not show.
  private itemEv(key: string, it: Item, w: number): Ev | null {
    switch (it.kind) {
      case 'tool':
        return ASKS.has(it.name) ? null : this.toolEv(it, w);
      case 'rich': {
        const d = it.detail;
        if (d.kind === 'plan') return { k: 'plan', id: it.id, w, plan: d.plan, live: true };
        if (d.kind === 'choice') return { k: 'permission', id: it.id, w, s: d.choice.question, verb: 'ask', live: true };
        if (d.kind === 'round') return { k: 'permission', id: it.id, w, s: d.round.title || d.round.questions[0]?.title || '', verb: 'ask', live: true };
        const title = 'title' in d ? d.title : d.kind === 'chart' ? d.chart.title : d.kind === 'table' ? d.table.title : d.kind === 'image' ? d.prompt : '';
        return { k: 'rich', id: key, w, s: `${NAMES[d.kind] ?? 'Card'}${title ? ` · ${title}` : ''}`, live: true };
      }
      case 'agent':
        return { k: 'text', id: key, w, live: true };
      case 'permission':
        return { k: 'permission', id: it.id, w, s: it.title || it.summary || it.tool, verb: it.questions ? 'ask' : it.plan ? 'plan' : 'allow', live: true };
      case 'error':
        return { k: 'error', id: key, w, s: it.message, live: true };
      default:
        return null;
    }
  }

  private ingestKey(key: string, it: Item, items: Record<string, Item>, w: number) {
    if (it.kind === 'group') {
      const seen = this.groupSeen.get(key) ?? 0;
      if (seen >= it.tools.length) return false;
      this.groupSeen.delete(key);
      this.groupSeen.set(key, it.tools.length);
      if (this.groupSeen.size > 64) this.groupSeen.delete(this.groupSeen.keys().next().value!);
      for (let j = seen; j < it.tools.length; j++) {
        const tool = items[it.tools[j]];
        if (tool?.kind === 'tool' && !this.ids.has(tool.id) && !ASKS.has(tool.name)) this.push(this.toolEv(tool, w));
      }
      return true;
    }
    if (this.known.has(key)) return false;
    this.remember(key);
    if (it.kind !== 'agent' && it.kind !== 'error' && this.ids.has(it.id)) return false;
    if (it.kind === 'rich' && it.partial) {
      this.pendingRich.add(key);
      if (this.pendingRich.size > 16) this.pendingRich.delete(this.pendingRich.values().next().value!);
      return false;
    }
    const e = it.kind === 'user' ? ({ k: 'user', id: it.id, w, s: it.text } as Ev) : this.itemEv(key, it, w);
    if (!e) return false;
    this.push(e);
    if (it.kind === 'permission' && it.answer !== null) this.settleLive(e, w, !it.answer);
    if (it.kind === 'agent' && !this.liveSay(e, it.text, false, this.mt(w))) {
      this.pendingSay.set(key, e);
      if (this.pendingSay.size > 16) this.pendingSay.delete(this.pendingSay.keys().next().value!);
    }
    return true;
  }

  // A streaming reply's narration, once its first sentence (and objective line) is written; true when nothing is left to wait for.
  private liveSay(e: Ev, text: string, done: boolean, t: number) {
    if (e.s === undefined) {
      const f = firstSentence(text);
      if (f.whole || done) e.s = f.s;
      if (e.s) this.narrate(e.s, e.w, t);
    }
    if (e.goal === undefined) {
      const g = goalOf(text);
      if (g.whole || done) e.goal = g.goal;
      if (e.goal) this.objective(e.goal, e.w, t);
    }
    return e.s !== undefined && e.goal !== undefined;
  }

  private narrate(s: string, w: number, t: number) {
    this.say = { w, s };
    capped(this.logOf('main').says, { w, t, s }, SAYS_MAX);
  }

  private objective(s: string, w: number, t: number) {
    capped(this.goals, { w, t, s }, GOALS_MAX);
  }

  // ---- One log entry at model time t: the same path for history and live. ----
  private ingest(e: Ev, t: number) {
    if (e.aid) return this.ingestSub(e, t);
    switch (e.k) {
      case 'user':
        this.say = null;
        this.power(true, t);
        this.recover(t);
        this.ask(e.s ?? '', t);
        return;
      case 'text':
        this.power(true, t);
        this.recover(t);
        this.mark(t, 'think');
        if (e.s) this.narrate(e.s, e.w, t);
        if (e.goal) this.objective(e.goal, e.w, t);
        return;
      case 'status':
        this.power(!!e.on, t);
        return;
      case 'turn-end':
        this.say = null;
        this.power(false, t);
        return;
      case 'plan':
        this.power(true, t);
        this.recover(t);
        if (e.plan) this.onPlan(e.plan, t);
        return;
      case 'rich':
        this.recover(t);
        this.addRow(this.work(t, null), { kind: 'rich', label: e.s ?? 'Card', key: e.id }, t);
        this.mark(t, 'think');
        return;
      case 'tool':
      case 'agent': {
        this.power(true, t);
        this.recover(t);
        const verb = e.k === 'agent' ? 'agent' : e.verb ?? '';
        const row = (e.row = this.ingestTool(verb, e.s ?? '', e, t));
        e.act = this.action(this.logOf('main'), e, verb, row.tLast, ACTS_MAIN);
        const st = this.cur!;
        if (verb === 'agent') {
          row.aid = e.id;
          const bx = st.x + RISE, lane: Lane = { row, st, bx, slot: this.slotFor(bx, row.t) };
          this.agents.push(lane);
          this.laneBy.set(e.id, lane);
          if (this.agents.length > AGENTS_MAX) for (const l of this.agents.splice(0, 32)) this.laneBy.delete(l.row.aid);
          this.grew(st, addBox(st.story, lane));
        } else this.grew(st, addAct(st.story, 'main', e.act));
        const act = actOf(verb);
        if (act === 'edit' || act === 'run' || verb === 'agent') this.await(e, this.pendingTools);
        return;
      }
      case 'permission': {
        const st = this.work(t, null);
        const row = (e.row = this.addRow(st, { kind: 'needs', label: e.s || 'Permission' }, t));
        this.mark(row.t, 'needs');
        this.call(st, row);
        this.grew(st, addCard(st.story, row));
        this.await(e, this.pendingNeeds);
        return;
      }
      case 'error': {
        const st = this.work(t, null);
        const row = (e.row = this.addRow(st, { kind: 'fault', label: e.s || 'Error', err: true }, t));
        this.mark(row.t, 'fault', row);
        this.call(st, row);
        this.grew(st, addCard(st.story, row));
        if (this.fault && this.fault.res === null) this.fault.res = row.t;
        this.fault = row;
      }
    }
  }

  // An outcome to come: in history it is known and waits for the replay to reach it; live, the store brings it.
  private await(e: Ev, pending: Map<string, Ev>) {
    if (e.end !== undefined && this.replaying) return this.queueSettle(e);
    pending.set(e.id, e);
    if (pending.size > 64) pending.delete(pending.keys().next().value!);
  }

  private queueSettle(e: Ev) {
    let i = this.settles.length;
    while (i > 0 && this.settles[i - 1].end! > e.end!) i--;
    this.settles.splice(i, 0, e);
  }

  // A subagent's entry from its transcript: an action on its own log, its narration or a progress note.
  private ingestSub(e: Ev, t: number) {
    const L = this.logOf(e.aid!);
    if (e.k === 'text') {
      if (e.s) capped(L.says, { w: e.w, t, s: e.s }, SAYS_MAX);
      return;
    }
    if (e.k === 'note') {
      const last = L.notes[L.notes.length - 1];
      capped(L.notes, { w: e.w, s: e.s ?? '', d: e.d ?? -1, n: e.n ?? 0, i: last ? last.i + 1 : 0 }, NOTES_MAX);
      return;
    }
    if (e.k !== 'tool' && e.k !== 'agent' && e.k !== 'permission') return;
    e.act = this.action(L, e, e.k === 'agent' ? 'agent' : e.verb ?? '', t, ACTS_SUB);
    const lane = this.laneBy.get(e.aid!);
    if (lane) this.grew(lane.st, addAct(lane.st.story, e.aid!, e.act));
    if (e.end === undefined) return;
    if (this.replaying) this.queueSettle(e);
    else this.settle(e, this.mt(e.end));
  }

  private logOf(aid: string) {
    let L = this.logs.get(aid);
    if (L) return L;
    this.logs.set(aid, (L = { aid, acts: [], more: this.subMore.get(aid) ?? 0, says: [], notes: [], steps: [] }));
    if (this.logs.size > AGENTS_MAX + 1) for (const k of this.logs.keys()) if (k !== 'main') return this.logs.delete(k), L;
    return L;
  }

  private action(L: AgentLog, e: Ev, verb: string, t: number, max: number): Action {
    const s = e.s ?? '';
    const a: Action = {
      id: e.id, verb, label: labelOf(verb, s, e.desc), cmd: isRun(verb) ? s : '', path: isFile(verb) ? s : '',
      w0: e.w, w1: null, t, res: null, err: false, why: '', add: e.add ?? 0, rm: e.rm ?? 0, created: !!e.created, check: isRun(verb) ? checkOf(s) : null,
    };
    const k = capped(L.acts, a, max);
    L.more += k;
    L.steps.push({ w: e.w, s: actionPhrase(a), d: -1, n: 0, i: L.more + L.acts.length - 1 });
    if (L.steps.length > L.acts.length) L.steps.splice(0, L.steps.length - L.acts.length);
    return a;
  }

  private settle(e: Ev, t: number) {
    const a = e.act;
    if (a) {
      a.w1 = e.end ?? null;
      a.res = Math.max(t, a.t);
      a.err = !!e.err;
      if (e.why) a.why = e.why;
    }
    const r = e.row;
    if (!r) return;
    r.w1 = e.end ?? null;
    if (r.kind === 'needs') {
      r.res = Math.max(t, r.t + 0.3);
      r.ans = e.ans ?? 'Answered';
      r.err = !!e.err;
      this.mark(r.res, 'think');
      return;
    }
    r.res = Math.max(t, r.tLast + 0.3);
    r.err ||= !!e.err;
    if (r.kind === 'run' && e.err && e.why) r.why = e.why;
    if (r.kind === 'agent') r.fin = e.state && e.state !== 'running' && e.state !== 'waiting' ? e.state : r.err ? 'failed' : 'done';
  }

  // Work going on after an error means he got past it.
  private recover(t: number) {
    const f = this.fault;
    if (!f || f.res !== null) return;
    f.res = Math.max(t, f.t + 0.6);
    f.w1 = this.wallOf(f.res);
    f.ans = 'Recovered';
    this.fault = null;
  }

  private power(on: boolean, t: number) {
    const r = this.runs;
    if (r.length && r[r.length - 1].on === on) return false;
    ins(r, { t, on });
    if (r.length > MARKS_MAX) r.splice(0, MARKS_MAX / 2);
    const c = this.cur;
    if (!on && c && c.kind !== 'start' && Number.isNaN(c.done)) c.done = Math.max(t, c.lastTv + 0.3);
    return true;
  }

  private ingestTool(verb: string, summary: string, e: Ev, t: number) {
    const act = actOf(verb);
    this.mark(t, act);
    const st = this.work(t, phaseOf(verb));
    st.tools++;
    let row: Row;
    if (act === 'read' && verb === 'read') row = this.fileRow(st, summary, null, t);
    else if (act === 'edit') row = this.fileRow(st, summary, { add: e.add ?? 0, rm: e.rm ?? 0, created: !!e.created || verb === 'write' }, t);
    else if (act === 'search') row = this.addRow(st, { kind: 'search', label: summary }, t);
    else if (act === 'run') (row = this.addRow(st, { kind: 'run', label: labelOf(verb, summary, e.desc) }, t)), (row.cmd = summary), (row.check = checkOf(summary));
    else row = this.addRow(st, { kind: verb === 'agent' ? 'agent' : 'other', label: labelOf(verb, summary, undefined) }, t);
    if (st.kind === 'phase') {
      const p = act === 'run' ? '' : summary;
      if (p) st.dirs.set(dirOf(p), (st.dirs.get(dirOf(p)) ?? 0) + 1);
      if (st.dirs.size > 24) st.dirs.delete(st.dirs.keys().next().value!);
      if (act === 'run' && st.cmds.length < 8) st.cmds.push(firstWords(summary));
      st.label = phaseLabel(st);
    }
    return row;
  }

  // ---- Where work goes: the plan's current step, or an automatic phase split where the kind of work changes. ----
  private work(t: number, phase: Phase | null): Station {
    const p = this.plan;
    if (p?.active) {
      // Stay on the current step until the plan says otherwise; else the next open step after it.
      const ci = this.cur ? p.st.indexOf(this.cur) : -1;
      if (ci >= 0 && Number.isNaN(p.st[ci].done)) return this.cur!;
      let i = p.st.findIndex((s, k) => k > ci && Number.isNaN(s.done));
      if (i < 0) i = p.st.findIndex((s) => Number.isNaN(s.done));
      if (i >= 0) {
        this.target(p.st[i], t);
        return this.cur!;
      }
    }
    const c = this.cur;
    const fresh = !c || c.kind !== 'phase';
    if (c && c.kind === 'phase' && !c.phase && phase) c.phase = phase;
    const split = fresh || (!!phase && !!c.phase && phase !== c.phase && c.tools >= SPLIT_TOOLS && t - c.t0 >= SPLIT_SECS);
    if (split) {
      const st = this.station('phase', '', t);
      st.phase = phase;
      this.insertNext(st);
      this.target(st, t);
    }
    return this.cur!;
  }

  private ask(text: string, t: number) {
    this.mark(t, 'think');
    const st = this.station('ask', text, t);
    this.insertNext(st);
    this.target(st, t);
    this.firstWork(st, t);
    st.last = t;
    st.lastTv = st.arr + 0.6;
  }

  private onPlan(spec: PlanSpec, t: number) {
    const texts = spec.steps.map((s) => s.text);
    let p = this.plan;
    // TodoWrite lists have no title, so only their steps say whether it is the same list.
    const same = !!p && ((!!spec.title && spec.title === p.title) || overlap(texts, p.texts) >= Math.ceil(0.6 * Math.max(texts.length, p.texts.length)));
    if (!same) {
      // A new plan drops the old plan's stations he never reached.
      if (p) this.dropPromises(p);
      p = this.plan = { title: spec.title, texts, st: [], active: true };
      for (let i = 0; i < texts.length; i++) {
        const st = this.station('step', texts[i], t);
        st.num = i;
        st.plan = p;
        p.st.push(st);
        this.stations.push(st);
      }
    } else if (p) {
      p.title = spec.title;
      p.texts = texts;
      for (let i = 0; i < texts.length; i++) {
        let st = p.st[i];
        if (!st) {
          st = this.station('step', texts[i], t);
          st.num = i;
          st.plan = p;
          p.st.push(st);
          this.stations.push(st);
        } else if (!this.scheduled(st)) st.label = texts[i];
      }
      for (const st of p.st.splice(texts.length)) {
        const i = this.stations.indexOf(st);
        if (i >= this.sched) this.stations.splice(i, 1);
      }
      p.active = true;
    }
    const plan = p!;
    spec.steps.forEach((s, i) => {
      const st = plan.st[i];
      // Marked done as early as the lag allows, so the check lands before he walks on.
      if (s.status === 'done' && Number.isNaN(st.done)) st.done = this.scheduled(st) ? Math.max(t - LAG + 0.1, st.lastTv + 0.2, lastOutcome(st) + 0.2) : t;
      if (s.status !== 'done') st.done = NaN;
    });
    const doing = spec.steps.findIndex((s) => s.status === 'doing');
    if (doing >= 0 && plan.st[doing] !== this.cur) this.target(plan.st[doing], t);
    if (spec.steps.every((s) => s.status === 'done')) plan.active = false;
    this.mark(t, 'think');
    this.layout();
  }

  private dropPromises(p: Plan) {
    this.stations = this.stations.filter((s, i) => s.plan !== p || i < this.sched);
  }

  // ---- Route: stations before `sched` have fixed walks; the ones after are promises laid out ahead of him. ----
  private scheduled(st: Station) {
    const i = this.stations.indexOf(st);
    return i >= 0 && i < this.sched;
  }

  private station(kind: StationKind, label: string, t: number): Station {
    const id = this.nextId++;
    const prev = this.stations[this.stations.length - 1];
    const { legs, tpl, dist } = legsFor(id, prev?.tpl ?? -1, kind);
    return {
      id, kind, label, num: -1, plan: null, phase: null, t0: t, dep: NaN, arr: NaN, first: NaN, last: -Infinity, done: NaN, past: this.replaying && !this.compress,
      x: 0, dist, base: dist, baseLegs: legs, tpl, legs, dur: legDur(legs), depMin: 0, passing: false,
      rows: [], byPath: new Map(), more: 0, tools: 0, lastTv: -Infinity, dirs: new Map(), cmds: [], beats: [], calls: [], says: [], story: newStory(),
    };
  }

  private addStart(t: number) {
    const st = this.station('start', '', t);
    st.legs = st.baseLegs = [];
    st.dist = st.base = 0;
    st.x = START_X;
    st.dep = st.arr = st.first = -Infinity;
    st.lastTv = -Infinity;
    this.stations.push(st);
    this.sched = 1;
    this.cur = st;
  }

  // A new station goes right after the ones he has a route to, ahead of the plan's promises.
  private insertNext(st: Station) {
    this.stations.splice(this.sched, 0, st);
  }

  private target(st: Station, t: number) {
    let i = this.stations.indexOf(st);
    // Work for a step he already walked past: a continuation of it, further along the floor.
    if (i >= 0 && i < this.sched) {
      const copy = this.station(st.kind, st.label, t);
      Object.assign(copy, { num: st.num, plan: st.plan, phase: st.phase });
      if (st.plan) st.plan.st[st.plan.st.indexOf(st)] = copy;
      if (Number.isNaN(st.done)) st.done = Math.max(t, st.lastTv + 0.2);
      this.insertNext(copy);
      st = copy;
      i = this.sched;
    }
    if (i < 0) return;
    for (let j = this.sched; j <= i; j++) this.scheduleOne(this.stations[j], this.stations[j - 1], t, j < i);
    this.sched = i + 1;
    this.cur = st;
    st.t0 = t;
    this.trim();
    this.layout();
  }

  // The walk in from prev, with extra floor first when prev has cards to the right of it.
  private fitLegs(st: Station, prev: Station) {
    const cols = this.tree ? 0 : cardCols(prev), end = this.tree ? reach(prev.story) : 0;
    const extra = cols ? Math.max(0, CALL_SPAN + (cols - 1) * COL_SPAN - st.base) : end ? Math.max(0, end + TREE_GAP - st.base) : 0;
    if (st.dist === st.base + extra) return;
    st.legs = extra ? widen(st.baseLegs, extra) : st.baseLegs;
    st.dist = st.base + extra;
  }

  private scheduleOne(st: Station, prev: Station, known: number, passing: boolean) {
    // He leaves prev: its lines keep only the room the floor after it was sized for.
    freeze(prev.story);
    this.fitLegs(st, prev);
    st.x = prev.x + st.dist;
    st.passing = passing;
    st.past = this.replaying && !this.compress;
    // He leaves after the last reaction at the previous station has played, and never before this was known.
    st.depMin = Math.max(prev.arr + (prev.passing ? 0.1 : 0.9), prev.lastTv + 0.45, known - LAG + 0.1);
    st.dep = st.depMin;
    st.dur = legDur(st.legs);
    // Falling behind live: a quicker walk.
    if (st.dep + st.dur > known + 0.8) st.dur = Math.max(1, st.dur * 0.65);
    st.arr = st.dep + st.dur;
    if (passing && Number.isNaN(st.done)) st.done = st.arr;
  }

  // The first tool at a station: if he has not set off yet, time the walk to land just before it (the lag's look-ahead).
  private firstWork(st: Station, t: number) {
    st.first = t;
    if (!this.replaying && st.dep <= this.viewNow() + 0.05) return;
    const dep = Math.max(st.depMin, t - 0.2 - st.dur);
    if (dep === st.dep) return;
    st.dep = dep;
    st.arr = dep + st.dur;
  }

  private layout(from = this.sched) {
    for (let j = Math.max(1, from); j < this.stations.length; j++) {
      const st = this.stations[j], prev = this.stations[j - 1];
      this.fitLegs(st, prev);
      st.x = prev.x + st.dist;
    }
  }

  // A station's tree reaches further right: the floor after it widens (only stations he has not reached yet move).
  private grew(st: Station, wider: boolean) {
    if (!wider) return;
    this.treeMax = Math.max(this.treeMax, reach(st.story));
    if (this.tree) this.layout();
  }

  // Trees or sculptures: every station moves to fit, keeping its walk times, so the view time stays where it was.
  setTree(on: boolean) {
    if (on === this.tree) return;
    this.tree = on;
    this.layout(1);
    for (const l of this.agents) l.bx = l.st.x + RISE;
    this.changed();
  }

  // Past the cap, the oldest stations go; their rows and beats with them.
  private trim() {
    const n = this.sched - STATIONS_MAX;
    if (n <= 0) return;
    const k = n + 200;
    this.stations.splice(0, k);
    this.sched -= k;
  }

  private mark(t: number, act: Act, row?: Row) {
    ins(this.marks, row ? { t, act, row } : { t, act });
    if (this.marks.length > MARKS_MAX) this.marks.splice(0, MARKS_MAX / 2);
  }

  // A question, error or agent gets a card at its station; the floor after it widens with each column of cards.
  private call(st: Station, row: Row) {
    const cols = cardCols(st);
    st.calls.push(row);
    if (st.calls.length > CALLS_MAX) {
      const i = st.calls.findIndex((r) => r.kind !== 'agent');
      st.calls.splice(Math.max(0, i), 1);
    }
    if (cardCols(st) !== cols) this.layout();
  }

  // The lowest lane height free at view time t: every lane on it ended before t and ends left of the new riser.
  private slotFor(bx: number, t: number) {
    const busy = new Set<number>();
    for (let i = this.agents.length - 1; i >= Math.max(0, this.agents.length - 64); i--) {
      const l = this.agents[i];
      if (busy.has(l.slot)) continue;
      const e = this.agentEnd(l.row);
      if (e.end === null || e.end > t || laneEnd(this, l) > bx - 48) busy.add(l.slot);
    }
    let k = 0;
    while (busy.has(k)) k++;
    return k;
  }

  private note(rows: AgentRow[] | undefined) {
    const w = wallNow();
    for (const p of rows ?? []) {
      if (p.main || (p.state !== 'running' && p.state !== 'waiting')) continue;
      const d = p.steps?.done ?? -1, n = p.steps?.total ?? 0;
      let l = this.alog.get(p.id);
      const last = l?.[l.length - 1];
      if (last && last.s === p.now && last.d === d) continue;
      if (!l) {
        this.alog.set(p.id, (l = []));
        if (this.alog.size > AGENTS_MAX) this.alog.delete(this.alog.keys().next().value!);
      }
      l.push({ w, s: p.now, d, n, i: last ? last.i + 1 : 0 });
      if (l.length > 24) l.shift();
    }
  }

  // The steps an agent's lane walks, oldest first: the progress calls in its transcript, else the steps the panel
  // reported while watch was open, else one per action it made.
  agentNotes(id: string): readonly AgentNote[] {
    const L = this.logs.get(id);
    if (L?.notes.length) return L.notes;
    const a = this.alog.get(id);
    if (a?.some((x) => x.n > 0)) return a;
    return L?.steps.length ? L.steps : (a ?? NONE);
  }

  // The newest step an agent reached by wall time w.
  agentNote(id: string, w: number) {
    const l = this.agentNotes(id);
    for (let i = l.length - 1; i >= 0; i--) if (l[i].w <= w) return l[i];
    return null;
  }

  agentLog(id: string) {
    return this.logs.get(id);
  }

  laneOf(aid: string) {
    return this.laneBy.get(aid);
  }

  // An agent's latest action by view time T and how many it had made by then (dropped ones included).
  actionAt(id: string, T: number): { act: Action | null; count: number } {
    const L = this.logs.get(id);
    if (!L) return { act: null, count: 0 };
    const j = upTo(L.acts, T);
    return { act: j ? L.acts[j - 1] : null, count: L.more + j };
  }

  // The view time of an agent's next action after T, so the loop wakes for it.
  nextAction(id: string, T: number) {
    const L = this.logs.get(id);
    const j = L ? upTo(L.acts, T) : 0;
    return L && j < L.acts.length ? L.acts[j].t : Infinity;
  }

  // His narration captioning a station at view time T, and the objective line in effect then.
  sayAt(st: Station, T: number) {
    return sayAt(st.says, T);
  }

  goalAt(T: number) {
    return sayAt(this.goals, T);
  }

  // The files an agent read or edited by view time T, in the order it first touched them; failed edits do not count.
  filesAt(id: string, T: number): FileTouchAt[] {
    const L = this.logs.get(id);
    if (!L) return [];
    const by = new Map<string, FileTouchAt>();
    for (const a of L.acts) {
      if (a.t > T) break;
      if (!a.path || (a.err && a.res !== null && a.res <= T)) continue;
      const edit = a.verb !== 'read', f = by.get(a.path);
      if (!f) by.set(a.path, { path: a.path, mode: edit ? 'edited' : 'read', add: edit ? a.add : 0, rm: edit ? a.rm : 0, created: a.created, n: 1, t0: a.t, t1: a.t });
      else {
        f.n++;
        f.t1 = a.t;
        if (edit) (f.mode = 'edited'), (f.add += a.add), (f.rm += a.rm), (f.created ||= a.created);
      }
    }
    return [...by.values()];
  }

  // The checks run at a station by view time T, oldest first.
  checksAt(st: Station, T: number): CheckAt[] {
    const out: CheckAt[] = [];
    for (const r of st.rows) {
      if (r.t > T) break;
      if (r.check) out.push({ kind: r.check, state: r.res === null || T < r.res ? 'running' : r.err ? 'failed' : 'ok', label: r.label, aid: 'main', t: r.t });
    }
    return out;
  }

  // Between wall times wA and wB: plan steps finished, agents that ended, errors, files edited and checks that
  // settled. Walks only the stations and actions inside the range.
  catchUp(wA: number, wB: number): CatchUp {
    const TA = this.modelOf(wA), TB = this.modelOf(wB);
    const out: CatchUp = { steps: [], agents: [], errors: [], files: [], checks: [], actions: 0 };
    const files = new Map<string, CatchUp['files'][number]>();
    const touch = (path: string, add: number, rm: number, by: string) => {
      const f = files.get(path) ?? { path, add: 0, rm: 0, by: [] };
      files.set(path, f);
      f.add += add;
      f.rm += rm;
      if (!f.by.includes(by)) f.by.push(by);
    };
    const S = this.stations, n = this.sched;
    // Stations on his route never get rows after he leaves them, so their last work times only grow.
    let lo = 1, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (S[mid].lastTv < TA && (Number.isNaN(S[mid].done) || S[mid].done < TA)) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < n && S[i].arr <= TB; i++) {
      const st = S[i];
      if (st.kind === 'step' && st.done >= TA && st.done <= TB) out.steps.push(st);
      for (const r of st.rows) {
        if (r.t > TB) break;
        const res = r.res !== null && r.res >= TA && r.res <= TB;
        if (r.kind === 'fault' && r.t >= TA) out.errors.push(r);
        if (r.kind === 'file' && r.mode === 'edited' && (r.tEdit ?? r.t) >= TA) touch(r.label, r.add, r.rm, 'main');
        if (r.check && res) out.checks.push({ kind: r.check, state: r.err ? 'failed' : 'ok', label: r.label, aid: 'main', t: r.res! });
      }
    }
    const M = this.logs.get('main');
    if (M) out.actions += upTo(M.acts, TB) - upTo(M.acts, TA);
    for (const lane of this.agents) {
      const r = lane.row;
      if (r.t > TB) break;
      const e = this.agentEnd(r);
      if (e.end !== null && e.end < TA) continue;
      if (e.end !== null && e.end <= TB) out.agents.push({ lane, fin: e.fin });
      const L = this.logs.get(r.aid);
      if (!L) continue;
      const a0 = upTo(L.acts, TA), a1 = upTo(L.acts, TB);
      out.actions += a1 - a0;
      for (let k = a0; k < a1; k++) {
        const a = L.acts[k];
        if (a.path && a.verb !== 'read' && !a.err) touch(a.path, a.add, a.rm, r.aid);
      }
      // A check may have started before the range and settled inside it.
      for (let k = 0; k < a1; k++) {
        const a = L.acts[k];
        if (a.check && a.res !== null && a.res >= TA && a.res <= TB) out.checks.push({ kind: a.check, state: a.err ? 'failed' : 'ok', label: a.label, aid: r.aid, t: a.res });
      }
    }
    out.files = [...files.values()];
    return out;
  }

  // The panel row for an agent, by its spawning tool_use id; the map is rebuilt only when the panel changes.
  panelAgent(id: string) {
    const a = useStore.getState().panels[this.sid]?.agents;
    if (a !== this.pan) {
      this.pan = a;
      this.panById = new Map((a ?? []).map((x) => [x.id, x]));
    }
    return this.panById.get(id);
  }

  // Live, the panel knows best (a background agent's tool result only says it started); history has the transcript.
  agentEnd(r: Row): AgentEnd {
    const p = r.aid ? this.panelAgent(r.aid) : undefined;
    if (p && !p.main) {
      if (p.state === 'running' || p.state === 'waiting') return { end: null, fin: 'running', p };
      let end = this.ends.get(p);
      if (end === undefined) {
        end = p.endedAt ? Math.max(r.t + 0.8, this.modelOf(fromServer(p.endedAt))) : (r.res ?? r.t + 0.8);
        this.ends.set(p, end);
      }
      return { end, fin: p.state, p };
    }
    return { end: r.res, fin: r.res === null ? 'running' : r.fin || (r.err ? 'failed' : 'done'), p };
  }

  // ---- Rows: one per file, search, command or card; each one is a beat he reacts to. ----
  private fileRow(st: Station, path: string, diff: { add: number; rm: number; created: boolean } | null, t: number) {
    const was = st.byPath.get(path);
    if (!was) {
      const row = this.addRow(st, { kind: 'file', label: path, key: `f:${path}` }, t);
      if (diff) Object.assign(row, { mode: 'edited', add: diff.add, rm: diff.rm, created: diff.created, tEdit: row.t });
      st.byPath.set(path, row);
      return row;
    }
    const tv = this.beat(st, t, was);
    was.n++;
    was.tLast = tv;
    if (diff) {
      if (was.mode === 'read') (was.mode = 'edited'), (was.tEdit = tv);
      was.add += diff.add;
      was.rm += diff.rm;
      was.created ||= diff.created;
    }
    return was;
  }

  private addRow(st: Station, o: { kind: RowKind; label: string; key?: string; err?: boolean }, t: number): Row {
    const row: Row = {
      key: o.key ?? `${o.kind}:${st.rows.length + st.more}`, kind: o.kind, label: o.label, t: 0, tEdit: null, tLast: 0, res: null,
      mode: 'read', add: 0, rm: 0, created: false, err: !!o.err, n: 1, w0: this.wallOf(t), w1: null, ans: '', aid: '', fin: '', cmd: '', why: '', check: null,
    };
    const tv = this.beat(st, t, row);
    row.t = row.tLast = tv;
    if (st.rows.length < ROWS_MAX) st.rows.push(row);
    else st.more++;
    return row;
  }

  // What he shows at view time: never before he stands there, and a beat apart so a burst reads as separate pushes.
  private beat(st: Station, t: number, row: Row) {
    if (Number.isNaN(st.first)) this.firstWork(st, t);
    const tv = Math.max(t, st.arr + 0.15, st.lastTv + 0.14);
    st.lastTv = tv;
    st.last = Math.max(st.last, t);
    st.beats.push({ tv, row });
    if (st.beats.length > BEATS_MAX) st.beats.splice(0, BEATS_MAX / 2);
    // What he said before this work captions the station from the row it led to.
    if (this.say) {
      capped(st.says, { w: this.say.w, t: tv, s: this.say.s }, SAYS_ST);
      this.say = null;
    }
    return tv;
  }

  // ---- Lookups for the view, by binary search on time. ----
  activityAt(T: number): Act | 'idle' {
    const m = this.marks;
    let lo = 0, hi = m.length - 1, k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (m[mid].t <= T) (k = mid), (lo = mid + 1);
      else hi = mid - 1;
    }
    const a = k >= 0 ? m[k] : null;
    // An error he has not got past holds the fault state, even after the turn ended on it.
    if (a?.act === 'fault' && a.row && (a.row.res === null || T < a.row.res)) return 'fault';
    if (!this.workingAt(T)) return 'idle';
    if (!a || a.act === 'fault') return 'think';
    // A tool long finished with nothing after it: he is thinking again.
    return T - a.t > 8 && a.act !== 'needs' ? 'think' : a.act;
  }

  workingAt(T: number) {
    const r = this.runs;
    let lo = 0, hi = r.length - 1, k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (r[mid].t <= T) (k = mid), (lo = mid + 1);
      else hi = mid - 1;
    }
    return k >= 0 && r[k].on;
  }

  // Stations [0, routeLen) have fixed walks: the route he actually takes.
  get routeLen() {
    return this.sched;
  }

  // The earliest view time the timeline can reach: 0, or the first kept station's walk once old ones are trimmed.
  get startT() {
    const d = this.stations[0]?.dep;
    return d !== undefined && Number.isFinite(d) ? d : 0;
  }
}

const NONE: readonly AgentNote[] = [];

// A station's card slots up to view time T, in the order they first appeared: the newest question and the newest
// error each keep one slot. Agents walk their own lanes instead.
export function cardSlots(st: Station, T = Infinity) {
  const slots: Row[] = [];
  let ni = -1, fi = -1;
  for (const r of st.calls) {
    if (r.t > T) break;
    if (r.kind === 'needs') ni < 0 ? ((ni = slots.length), slots.push(r)) : (slots[ni] = r);
    else if (r.kind === 'fault') fi < 0 ? ((fi = slots.length), slots.push(r)) : (slots[fi] = r);
  }
  return slots;
}

// Column per slot: a question and an error fit above his head.
export const packCards = (slots: Row[]) => slots.map((_, i) => Math.floor(i / CARD_SLOTS));

export function cardCols(st: Station) {
  const p = packCards(cardSlots(st));
  return p.length ? p[p.length - 1] + 1 : 0;
}

const lastOutcome = (st: Station) => {
  let t = -Infinity;
  for (let i = Math.max(0, st.rows.length - 6); i < st.rows.length; i++) t = Math.max(t, st.rows[i].res ?? -Infinity);
  return t;
};

function phaseLabel(st: Station) {
  if (st.phase === 'check') {
    const uniq = [...new Set(st.cmds)];
    return uniq.length === 1 ? `Running ${uniq[0]}` : uniq.length ? 'Running checks' : 'Running';
  }
  let best = '', n = 0;
  for (const [d, c] of st.dirs) if (c > n) (best = d), (n = c);
  const where = best || 'files';
  return st.phase === 'build' ? `Editing ${where}` : st.phase === 'explore' ? `Exploring ${where}` : `Working in ${where}`;
}
