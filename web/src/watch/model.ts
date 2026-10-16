import type { AgentRow, AgentState, PlanSpec, WatchEntry, WatchTimelineMessage } from '../../../server/protocol.ts';
import { useStore, type Item } from '../store.ts';
import { send } from '../socket.ts';
import { fromServer, onTimeline, stampOf, wallNow } from './open.ts';
import { legDur, legsFor, widen, type Leg } from './director.ts';
import { RISE, laneEnd, type Lane } from './lanes.ts';

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
  // Pulses he makes here, in time order; the questions and errors that get a card.
  beats: Beat[]; calls: Row[];
};
type Plan = { title: string; texts: string[]; st: Station[]; active: boolean };
type Mark = { t: number; act: Act; row?: Row };

// The model's log: the server's timeline, then live store items in the same shape. w and end are local wall seconds.
type Ev = {
  k: WatchEntry['k'] | 'rich' | 'status'; id: string; w: number; end?: number; err?: boolean;
  verb?: string; s?: string; add?: number; rm?: number; created?: boolean; plan?: PlanSpec; on?: boolean;
  // How a resolved question reads; live tells allow from deny, the transcript cannot.
  ans?: string; live?: boolean; row?: Row; state?: AgentState;
};

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
  if (e.add !== undefined) (ev.add = e.add), (ev.rm = e.rm ?? 0), (ev.created = !!e.created);
  if (e.plan) ev.plan = e.plan;
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

  constructor(sid: string) {
    this.sid = sid;
    const s = useStore.getState();
    this.status = s.status;
    this.note(s.panels[sid]?.agents);
    onTimeline((msg) => {
      if (msg.sessionId === this.sid) this.onPage(msg);
    });
    this.request(undefined);
    this.timer = window.setTimeout(() => this.fallback(), WAIT_MS);
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
    const w0 = log.length ? log[0].w : now;
    this.origin = w0 - LEAD;
    this.lastW = w0;
    this.runs.push({ t: 0, on: false });
    this.addStart(0);
    for (const e of log) {
      this.flush(e.w);
      this.ingest(e, this.mt(e.w));
    }
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
    return true;
  }

  // ---- One log entry at model time t: the same path for history and live. ----
  private ingest(e: Ev, t: number) {
    switch (e.k) {
      case 'user':
        this.power(true, t);
        this.recover(t);
        this.ask(e.s ?? '', t);
        return;
      case 'text':
        this.power(true, t);
        this.recover(t);
        this.mark(t, 'think');
        return;
      case 'status':
        this.power(!!e.on, t);
        return;
      case 'turn-end':
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
        if (verb === 'agent') {
          row.aid = e.id;
          const st = this.cur!, bx = st.x + RISE;
          this.agents.push({ row, st, bx, slot: this.slotFor(bx, row.t) });
          if (this.agents.length > AGENTS_MAX) this.agents.splice(0, 32);
        }
        const act = actOf(verb);
        if (act === 'edit' || act === 'run' || verb === 'agent') this.await(e, this.pendingTools);
        return;
      }
      case 'permission': {
        const st = this.work(t, null);
        const row = (e.row = this.addRow(st, { kind: 'needs', label: e.s || 'Permission' }, t));
        this.mark(row.t, 'needs');
        this.call(st, row);
        this.await(e, this.pendingNeeds);
        return;
      }
      case 'error': {
        const st = this.work(t, null);
        const row = (e.row = this.addRow(st, { kind: 'fault', label: e.s || 'Error', err: true }, t));
        this.mark(row.t, 'fault', row);
        this.call(st, row);
        if (this.fault && this.fault.res === null) this.fault.res = row.t;
        this.fault = row;
      }
    }
  }

  // An outcome to come: in history it is known and waits for the replay to reach it; live, the store brings it.
  private await(e: Ev, pending: Map<string, Ev>) {
    if (e.end !== undefined && this.replaying) {
      let i = this.settles.length;
      while (i > 0 && this.settles[i - 1].end! > e.end) i--;
      this.settles.splice(i, 0, e);
      return;
    }
    pending.set(e.id, e);
    if (pending.size > 64) pending.delete(pending.keys().next().value!);
  }

  private settle(e: Ev, t: number) {
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
    else if (act === 'run') row = this.addRow(st, { kind: 'run', label: summary }, t);
    else row = this.addRow(st, { kind: verb === 'agent' ? 'agent' : 'other', label: verb === 'agent' ? summary : `${verb} ${summary}`.trim() }, t);
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
      rows: [], byPath: new Map(), more: 0, tools: 0, lastTv: -Infinity, dirs: new Map(), cmds: [], beats: [], calls: [],
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
    const cols = cardCols(prev);
    const extra = cols ? Math.max(0, CALL_SPAN + (cols - 1) * COL_SPAN - st.base) : 0;
    if (st.dist === st.base + extra) return;
    st.legs = extra ? widen(st.baseLegs, extra) : st.baseLegs;
    st.dist = st.base + extra;
  }

  private scheduleOne(st: Station, prev: Station, known: number, passing: boolean) {
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

  private layout() {
    for (let j = Math.max(1, this.sched); j < this.stations.length; j++) {
      const st = this.stations[j], prev = this.stations[j - 1];
      this.fitLegs(st, prev);
      st.x = prev.x + st.dist;
    }
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

  // Every step an agent reported while watch was open, oldest first; empty for history.
  agentNotes(id: string): readonly AgentNote[] {
    return this.alog.get(id) ?? NONE;
  }

  // The newest step an agent reported by wall time w.
  agentNote(id: string, w: number) {
    const l = this.alog.get(id);
    if (!l) return null;
    for (let i = l.length - 1; i >= 0; i--) if (l[i].w <= w) return l[i];
    return null;
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
      mode: 'read', add: 0, rm: 0, created: false, err: !!o.err, n: 1, w0: this.wallOf(t), w1: null, ans: '', aid: '', fin: '',
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
