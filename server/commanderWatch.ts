import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';
import { tuning } from './profile.ts';
import { LIVE_SERVER, tmpName, type Tab } from './workspace.ts';
import { waitingText, type AskSettle } from './session/asks.ts';
import { guard } from './session/util.ts';
import { oneLine } from './text.ts';
import { APPROVAL_BATCH, APPROVAL_CHARS, approvalFits, approvalText, wakeText } from './commander.ts';
import { destructive, type AskFacts } from './destructive.ts';
import type { Session } from './session.ts';
import type { GroupStore } from './groups.ts';
import type { CmdrAgents, CmdrNote, CmdrRef, CmdrSide, CommanderRows, PinnedAsk, RelayEvent, RelayFrom, RelayedEvent, ServerEvent, SessionGroup, TimedEvent } from './protocol.ts';
import { mergeTimed } from './providerSwitch.ts';

// Notes kept for the commander's conversation, oldest dropped first; a collapsed note names at most GROUP_MAX sessions.
const NOTES_MAX = 200;
const GROUP_MAX = 50;
// Pinned asks at most; past this, newer asks wait outside the stack until older ones are answered.
const PINS_MAX = 100;
// Subagents per session row; the rest are only counted.
const AGENTS_MAX = 12;
// Relayed card events kept for the commander's conversation, the oldest of settled cards dropped first.
const RELAYS_MAX = 100;
const SAVE_MS = 2000;
const NOTES_FILE = join(CACHE_DIR, 'commander-notes.json');
const RELAYS_FILE = join(CACHE_DIR, 'commander-relays.json');
const GROUP_RELAYS_FILE = join(CACHE_DIR, 'group-relays.json');
const DELEGATIONS_FILE = join(CACHE_DIR, 'commander-delegations.json');
// Bound startup allocation before JSON parsing, including all groups in one file.
const FILE_BYTES = 32 << 20;
const RELAY_BYTES = 64 << 10;
const QUIET_MS = 5000;
const DELEGATIONS_MAX = 500;
// Matches load validation even when wakeText keeps an oversized final code block whole.
const NOTICE_MAX = 16000;
// Card kinds relayed from every session, and those relayed only from a session the commander handed work to.
const ASKS = new Set(['round', 'checklist', 'prototype', 'upload']);
const VISUALS = new Set(['visual', 'replay', 'picture']);
const INTERRUPTED = 'was interrupted by a server restart';

type Stored = { id: string; at: number; note: CmdrNote };
const str = z.string();
const num = z.number().finite();
const bool = z.boolean();
const mode = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
const ref = z.object({ sessionId: str, name: str, text: str, at: num });
const side = z.object({ provider: z.enum(['claude', 'codex', 'opencode']), model: str });
const noteSchema = z.object({ id: str, at: num, note: z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['ask', 'failed', 'done']), refs: z.array(ref).max(GROUP_MAX) }),
  z.object({ kind: z.literal('handoff'), from: side, to: side }),
  z.object({ kind: z.literal('answered'), ref, allow: bool.nullable(), by: z.enum(['you', 'phone', 'cancelled', 'commander']), tool: str, command: str, reason: str.optional() }),
]) });
const option = z.object({ label: str, description: str });
const diff = z.object({ kind: z.literal('diff'), path: str, add: num, rm: num, lines: z.array(z.tuple([z.enum(['-', '+', ' ']), str])), more: num, created: bool });
const detail = z.discriminatedUnion('kind', [
  diff,
  z.object({ kind: z.literal('visual'), html: str, width: num, height: num, durationMs: num, title: str, interactive: bool, wrote: num.optional() }),
  z.object({ kind: z.literal('prototype'), html: str, width: num, height: num, title: str, question: str, variants: z.array(z.object({ label: str, html: str })).optional(), placeholders: str.optional(), wrote: num.optional(), styled: z.literal(true).optional() }),
  z.object({ kind: z.literal('replay'), title: str, page: num }),
  z.object({ kind: z.literal('picture'), path: str, caption: str }),
  z.object({ kind: z.literal('upload'), prompt: str, accept: z.array(str) }),
  z.object({ kind: z.literal('image'), prompt: str, count: num }),
  z.object({ kind: z.literal('round'), round: z.object({ title: str, questions: z.array(z.object({ title: str, setup: str, options: z.array(option), recommended: num.nullable(), why: str, kind: z.enum(['choice', 'text', 'number', 'path']).optional(), placeholder: str.optional(), suggested: str.optional() })) }) }),
  z.object({ kind: z.literal('checklist'), checklist: z.object({ title: str, items: z.array(z.object({ label: str, note: str, recommended: bool })) }) }),
  z.object({ kind: z.literal('choice'), choice: z.object({ question: str, options: z.array(option) }) }),
  z.object({ kind: z.literal('plan'), plan: z.object({ title: str, steps: z.array(z.object({ text: str, status: z.enum(['todo', 'doing', 'done']) })) }) }),
  z.object({ kind: z.literal('table'), table: z.object({ title: str, note: str, columns: z.array(str), rows: z.array(z.array(str)), align: z.array(z.enum(['left', 'right', 'center'])) }) }),
  z.object({ kind: z.literal('chart'), chart: z.object({ type: z.enum(['bar', 'line', 'area', 'stat']), title: str, unit: str, labels: z.array(str), series: z.array(z.object({ name: str, values: z.array(num) })) }) }),
  z.object({ kind: z.literal('visual-mode'), mode: z.object({ visual: z.enum(['render_ui', 'ask_prototype', 'replay']), title: str, figure: bool.optional(), fixed: z.enum(['here', 'background']).optional() }) }),
]);
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), id: str, delta: str }),
  z.object({ type: z.literal('tool'), id: str, name: str, verb: str, summary: str, desc: str.optional(), detail: detail.optional(), partial: bool.optional(), fold: str.optional(), replaces: str.optional() }),
  z.object({ type: z.literal('permission'), id: str, tool: str, summary: str, command: str.optional(), title: str.optional(), defaultToNo: bool.optional(), detail: diff.optional(), questions: z.array(z.object({ question: str, header: str, multiSelect: bool, options: z.array(option.extend({ preview: str.optional() })) })).optional(), plan: str.optional(), back: mode.optional(), always: z.literal(true).optional() }),
  z.object({ type: z.literal('permission-resolved'), id: str, allow: bool, reply: z.object({ answers: z.record(str, str).optional(), mode: mode.optional(), feedback: str.optional(), always: z.literal(true).optional() }).optional(), elsewhere: bool.optional(), cancelled: z.literal(true).optional() }),
  z.object({ type: z.literal('tool-result'), id: str, error: str.nullable(), choice: num.nullable().optional(), answer: str.optional(),
    round: z.array(z.object({ option: num.nullable(), note: str })).nullable().optional(), roundExtra: str.optional(),
    proto: z.object({ values: z.record(str, z.unknown()), note: str, dropped: z.array(str).optional(), variant: str.optional(), comments: z.array(z.object({ variant: str.optional(), on: str, selector: str, text: str })).optional() }).nullable().optional(),
    checklist: z.object({ ticked: z.array(num), note: str }).nullable().optional(), png: str.optional(), img: str.optional(),
    visualMode: z.object({ where: z.enum(['here', 'background']), remember: bool, figure: bool.optional(), saved: bool.optional(), saveError: str.optional(), skipped: z.literal(true).optional() }).nullable().optional(),
    images: z.array(z.object({ src: str, path: str })).optional(), ms: num.optional(), brief: str.optional(),
    video: z.object({ path: str, src: str, poster: str.nullable(), ms: num, w: num, h: num, bytes: num.optional(), title: str.nullable().optional() }).optional(),
    uploads: z.array(z.object({ path: str, name: str, bytes: num, src: str.optional() })).optional(), pagePngs: z.array(z.object({ id: str, png: str })).optional(), theme: z.literal('auto').optional(),
  }),
]);
const relaySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cmdr-relay-end'), id: str, at: num }),
  z.object({ type: z.literal('cmdr-relay'), id: str, at: num, from: z.object({ sessionId: str, name: str, cwd: str }), event: eventSchema }),
]);
type Completion = { at: number; outcome: string; text: string; from: RelayFrom; reply?: string; ready: boolean; quiet?: number; blockers?: Session['completionBlockers'] };
type Delegation = { id: string; savedId: string | null; end: number; notice?: string; reported?: boolean; human?: string | null; terminal?: boolean; completion?: Completion };

function boundedNotice(text: string) {
  const omitted = '\n\n[Reply omitted: notice exceeded its size limit. Use session_read on the delegated session for the full result.]';
  return text.length <= NOTICE_MAX ? text : text.slice(0, NOTICE_MAX - omitted.length) + omitted;
}

function readStored(file: string): unknown {
  if (statSync(file).size > FILE_BYTES) throw new Error('Watcher file exceeds its byte limit');
  const text = readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > FILE_BYTES) throw new Error('Watcher file exceeds its byte limit');
  return JSON.parse(text);
}

function readDelegations(): Map<string, Map<string, Delegation>> {
  if (!LIVE_SERVER) return new Map();
  try {
    const row = z.object({ id: str, savedId: str.nullable(), end: num, notice: str.max(NOTICE_MAX).optional(), reported: bool.optional(), human: str.nullable().default(null), terminal: bool.optional(), completion: z.object({ at: num, outcome: str, text: str.max(NOTICE_MAX), from: z.object({ sessionId: str, name: str, cwd: str }), reply: str.max(NOTICE_MAX).optional(), ready: bool, quiet: num.optional(), blockers: z.object({ background: bool, queued: bool, active: bool, ask: bool }).optional() }).optional() });
    const v = readStored(DELEGATIONS_FILE);
    if (!Array.isArray(v)) return new Map();
    return new Map(v.slice(-501).flatMap((x) => {
      if (!x || typeof x.scope !== 'string' || !Array.isArray(x.rows)) return [];
      const rows: Delegation[] = x.rows.slice(-DELEGATIONS_MAX).flatMap((r: unknown) => {
        const p = row.safeParse(r);
        if (!p.success) return [];
        const d = p.data;
        const c = d.completion;
        // Losing execution blockers is interruption, not proof of success; legacy pending records lack that proof too.
        if (!d.terminal && c && (c.blockers ? Object.values(c.blockers).some(Boolean) : !c.ready)) {
          const pending = c.blockers ? [c.blockers.background && 'background work', c.blockers.queued && 'queued messages or reports', c.blockers.active && 'an active turn', c.blockers.ask && 'an unanswered ask'].filter(Boolean).join(', ') : 'unconfirmed work';
          c.outcome = INTERRUPTED;
          c.text = boundedNotice(`A task you delegated ${INTERRUPTED}: session "${c.from.name}" (${c.from.sessionId}).\n\nIt was still waiting on ${pending}. Completion was not confirmed; inspect the session before resuming or reporting success.`);
          delete c.reply;
          d.notice = boundedNotice(c.text + (d.notice ? `\n\nEarlier completion notice:\n${d.notice}` : ''));
          d.terminal = true;
        }
        return [d];
      });
      return [[x.scope, new Map(rows.map((r) => [r.id, r]))] as const];
    }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log('commander: unreadable delegations; starting without them');
    return new Map();
  }
}

// Like the commander record, only the live server keeps notes on disk; test servers share the cache dir.
function readNotes(): Stored[] {
  if (!LIVE_SERVER) return [];
  try {
    const v = readStored(NOTES_FILE);
    return Array.isArray(v) ? v.flatMap((x) => { const p = noteSchema.safeParse(x); return p.success ? [p.data] : []; }).slice(-NOTES_MAX) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log('commander: unreadable notes; its conversation starts without them');
    return [];
  }
}

type Kept = RelayEvent & { at: number };

// An omitted card keeps a visible pointer; the live ask and its controls remain in the source tab.
function boundedRelay<T extends RelayEvent>(e: T, compact = false): T {
  if (e.type !== 'cmdr-relay' || (!compact && Buffer.byteLength(JSON.stringify(e)) <= RELAY_BYTES)) return e;
  return { ...e, from: { sessionId: e.from.sessionId, name: e.from.name.slice(0, 120), cwd: '' }, event: {
    type: 'text', id: e.event.id, delta: 'Card payload omitted from this view. Open its source tab to view it; any live ask still waits there.',
  } };
}

function restoreRelays(v: unknown): Kept[] {
  const list: Kept[] = Array.isArray(v) ? v.flatMap((x) => {
    const p = relaySchema.safeParse(x);
    return p.success ? [boundedRelay(p.data)] : [];
  }).slice(-RELAYS_MAX) : [];
  // No ask outlives the process that waited on it, so the ones still open end here.
  const open = new Set<string>();
  for (const e of list) {
    if (e.type === 'cmdr-relay' && (e.event.type === 'permission' || (e.event.type === 'tool' && ASKS.has(e.event.detail?.kind ?? '')))) open.add(e.id);
    else open.delete(e.id);
  }
  const restored = [...list, ...[...open].map((id) => ({ type: 'cmdr-relay-end' as const, id, at: Date.now() }))];
  return Buffer.byteLength(JSON.stringify(restored)) > 60_000 ? restored.map((r) => boundedRelay(r, true)) : restored;
}

function readRelays(): Kept[] {
  if (!LIVE_SERVER) return [];
  try {
    const v = readStored(RELAYS_FILE);
    return restoreRelays(v);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log('commander: unreadable relayed cards; its conversation starts without them');
    return [];
  }
}

function readGroupRelays(): Map<string, Kept[]> {
  if (!LIVE_SERVER) return new Map();
  try {
    const rows = readStored(GROUP_RELAYS_FILE);
    return new Map(Array.isArray(rows) ? rows.slice(-500).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, restoreRelays(r.rows)]) : []);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log('groups: unreadable relayed cards; starting without them');
    return new Map();
  }
}

// The turn that only acknowledged a handoff after a compaction: no work ended with it.
function ackEnd(s: Session) {
  return s.lastEnd === 'ok' && s.handoffInput;
}
const fromOf = (s: Session): RelayFrom =>({ sessionId: s.id, name: s.name, cwd: s.cwd });


export type WatchHost = {
  groups?: GroupStore;
  session?: (id: string) => Session | undefined;
  parkedSession?: (id: string) => Tab | undefined;
  log: (s: Session, text: string) => void;
  // The open commander; undefined while it is parked or closed.
  live: () => Session | undefined;
  // A commander tab exists, open or parked; nothing is watched otherwise.
  exists: () => boolean;
  // The Commander's power switch; while off, delegated work and open cards are dropped instead of kept for later.
  on?: () => boolean;
  // Open sessions and parked tabs, the commander left out.
  sessions: () => Iterable<Session>;
  parked: () => Iterable<Tab>;
  // The folders a session may write in: its own and its worktree.
  roots: (s: Session) => string[];
};

// What the watch last saw of a session, so each change becomes one note.
type Seen = { asks: Set<string>; ends: number; interrupted: boolean };
// A pin under auto-approve: being checked, queued for the commander, with it since its turn-end count was turn (gen:
// the switch's generation then), held by the checker, left by the commander, or returned when that turn ended without
// an answer (it stays with the user, not sent again).
type Review =
  | { state: 'checking' | 'returned' } | { state: 'queued'; facts?: AskFacts } | { state: 'reviewing'; turn: number; gen: number }
  | { state: 'held' | 'left'; why: string };
export type CmdrDecision = 'allow' | 'deny' | 'leave';
// The pins a voice call announces: under auto-approve only those back with the user.
const withUser = (p: PinnedAsk) => !p.auto || p.auto === 'held' || p.auto === 'left';

// Watches the other sessions for the commander: conversation notes, pinned asks, subagent rows and delegated work.
export class CommanderWatch {
  // One root per session manager, removed after its final write; groups share the root's files.
  private static roots = new Set<CommanderWatch>();
  private finishing: Promise<void> | null = null;

  static async finishAll() {
    await Promise.all([...this.roots].map((watch) => watch.finish()));
  }
  private host: WatchHost;
  private notes: Stored[];
  private relays: Kept[];
  // At most GroupStore's 500 groups; each keeps RELAYS_MAX settled events plus cards still waiting, like the commander.
  private groupWatches = new Map<string, CommanderWatch>();
  private groupRelays: Map<string, Kept[]>;
  private group?: { rows: Kept[]; save: (rows: Kept[]) => void };
  // Relayed cards with no closing event yet, by "<sessionId>:<id>": an ask tool, an AskUserQuestion or plan card, or a visual.
  // Kept while the commander is closed, so a card settled meanwhile shows that when its conversation comes back.
  private open = new Map<string, { from: RelayFrom; kind: 'ask' | 'perm' | 'visual' }>();
  // False until the first tick with a commander, and again once it is gone.
  private watching = false;
  // A relayed card's permission-resolved, held until settled() says whether it was an answer.
  private resolved: RelayedEvent | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private writing = Promise.resolve();
  // One entry per open or parked session; dropped when the session goes or the commander closes.
  private seen = new Map<string, Seen>();
  private pins = new Map<string, PinnedAsk>();
  // Stable tab/transcript identities and completion times survive process-local turn counter resets.
  private delegated: Map<string, Delegation>; // At most DELEGATIONS_MAX targets per scope, including undelivered notices.
  private delegationScopes: Map<string, Map<string, Delegation>>; // Commander plus at most 500 groups.
  // Per open session: the panel revision last read, its row, and that row's JSON to tell a visible change from streaming.
  private agentRows = new Map<string, { rev: number; row: CmdrAgents | null; json: string }>();
  // Auto-approve lives in memory only, so every start begins with it off. review has one entry per pin at most.
  private auto = false;
  private review = new Map<string, Review>();
  // Bumped on every flip of the switch, so checks and answers begun before it are dropped.
  private gen = 0;
  // Set while a permission_answer call settles its ask, so settled() records the commander and its reason.
  private answering: { key: string; reason: string } | null = null;

  constructor(host: WatchHost, group?: { rows: Kept[]; save: (rows: Kept[]) => void; delegated: Map<string, Delegation> }) {
    this.host = host;
    this.group = group;
    this.notes = group ? [] : readNotes();
    this.relays = group ? group.rows : readRelays();
    this.groupRelays = group ? new Map() : readGroupRelays();
    this.delegationScopes = group ? new Map() : readDelegations();
    this.delegated = group?.delegated ?? this.delegationScopes.get('commander') ?? new Map();
    if (!group) this.delegationScopes.set('commander', this.delegated);
    if (!group) CommanderWatch.roots.add(this);
  }

  private forGroup(g: SessionGroup) {
    let watch = this.groupWatches.get(g.id);
    if (!watch) {
      const delegated = this.delegationScopes.get(g.id) ?? new Map<string, Delegation>();
      this.delegationScopes.set(g.id, delegated);
      watch = new CommanderWatch({
        live: () => this.host.session?.(g.main.id), exists: () => true,
        sessions: () => g.children.flatMap((m) => this.host.session?.(m.id) ?? []),
        parked: () => g.children.flatMap((m) => this.host.parkedSession?.(m.id) ?? []), roots: this.host.roots, log: () => {},
      }, { rows: this.groupRelays.get(g.id) ?? [], delegated, save: (rows) => { this.groupRelays.set(g.id, rows); this.save(); } });
      this.groupWatches.set(g.id, watch);
    }
    return watch;
  }

  private parentOf(id: string) {
    const g = this.host.groups?.of(id);
    return g && g.main.id !== id && g.main.savedId !== id ? this.forGroup(g) : undefined;
  }

  delegateGroup(target: Session) { this.parentOf(target.id)?.delegate(target); }

  groupPins(id: string): PinnedAsk[] {
    const g = this.host.groups?.of(id);
    return g && g.main.id === id ? [...this.forGroup(g).pins.values()] : [];
  }

  withGroupRelays(events: TimedEvent[], s: Session, savedId: string) {
    const g = this.host.groups?.of(s.id) ?? this.host.groups?.of(savedId);
    return g && (g.main.id === s.id || g.main.savedId === savedId) ? this.forGroup(g).withNotes(events, s) : events;
  }

  // Runs on every roster change; one pass over the sessions.
  tick() {
    if (this.stopped) return;
    if (this.host.groups) {
      const groups = this.host.groups.list();
      const ids = new Set(groups.map((g) => g.id));
      for (const [id, watch] of this.groupWatches) if (!ids.has(id)) {
        if (watch.wakeTimer) clearTimeout(watch.wakeTimer);
        this.groupWatches.delete(id);
      }
      for (const id of this.groupRelays.keys()) if (!ids.has(id)) { this.groupRelays.delete(id); this.save(); }
      for (const id of this.delegationScopes.keys()) if (id !== 'commander' && !ids.has(id)) { this.delegationScopes.delete(id); this.save(); }
      for (const g of groups) this.forGroup(g).tick();
    }
    if (!this.host.exists()) {
      this.seen.clear();
      this.pins.clear();
      if (this.host.on?.() === false) this.dropPending();
      else this.wakes(new Map([...this.host.sessions()].map((s) => [s.id, s])));
      this.agentRows.clear();
      this.auto = false;
      this.review.clear();
      this.watching = false;
      return;
    }
    // The commander starts watching: asks that already wait in open sessions get their cards now.
    if (!this.watching) {
      this.watching = true;
      for (const s of this.host.sessions()) {
        if (!s.askCards.size) continue;
        for (const e of s.eventsAfter(0)) if ((e.type === 'tool' || e.type === 'permission') && s.askCards.has(e.id)) this.relay(s, e);
      }
    }
    const ids = new Set<string>();
    const open = new Map<string, Session>();
    const pins = new Map<string, PinnedAsk>();
    for (const s of this.host.sessions()) {
      ids.add(s.id);
      open.set(s.id, s);
      const prev = this.seen.get(s.id);
      const interrupted = !!s.interruptedNote;
      const ref = (text: string): CmdrRef => ({ sessionId: s.id, name: s.name, text, at: Date.now() });
      // The first sight is a baseline, except a restart's cut that no note has named yet.
      if (prev) {
        for (const [id, a] of s.askCards) if (!prev.asks.has(id)) this.note('ask', ref(waitingText(a).replace(/^Waiting/, 'is waiting')));
        if (s.ends > prev.ends && !ackEnd(s)) this.note(s.lastEnd === 'ok' ? 'done' : 'failed', ref(s.lastEnd === 'ok' ? 'turn ended' : s.lastEnd === 'stopped' ? 'was stopped' : 'failed'));
      }
      if (interrupted && !prev?.interrupted && (prev || !this.named(s.id, s.lastActive))) this.note('failed', ref(INTERRUPTED));
      this.seen.set(s.id, { asks: new Set(s.askCards.keys()), ends: s.ends, interrupted });
      for (const [id, a] of s.askCards) {
        if (!a.card || pins.size >= PINS_MAX) continue;
        const key = `${s.id} ${id}`;
        const old = this.pins.get(key);
        pins.set(key, old?.name === s.name ? old : { id: key, ask: { sessionId: s.id, id, ...a.card }, name: s.name, cwd: s.cwd, at: old?.at ?? Date.now() });
      }
    }
    for (const t of this.host.parked()) {
      ids.add(t.id);
      const prev = this.seen.get(t.id);
      const interrupted = !!t.interrupted;
      if (interrupted && !prev?.interrupted && (prev || !this.named(t.id, t.lastActive))) this.note('failed', { sessionId: t.id, name: t.name, text: INTERRUPTED, at: Date.now() });
      this.seen.set(t.id, { asks: new Set(), ends: prev?.ends ?? 0, interrupted });
    }
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);
    for (const id of this.agentRows.keys()) if (!open.has(id)) this.agentRows.delete(id);
    this.pins = new Map([...pins].sort(([, a], [, b]) => a.at - b.at));
    for (const k of this.review.keys()) if (!this.pins.has(k)) this.review.delete(k);
    this.wakes(open);
    if (!this.group) {
      this.offer(open);
      this.host.live()?.commanderCallAsks(this.flagged().filter(withUser));
    }
  }

  // Off stops hand-offs at once and clears every mark; on checks every pin again, those pinned before included.
  setAutoApprove(on: boolean) {
    this.auto = on;
    this.gen++;
    this.review.clear();
  }

  // Under auto-approve: each new pin goes through the checker (async, it may read the disk), and those that pass reach
  // the commander in one message once its turn is over. An ask whose turn ended unanswered stays with the user.
  private offer(open: Map<string, Session>) {
    const live = this.host.live();
    if (!live) this.auto = false;
    if (!this.auto || !live) return;
    const idle = !live.turnRunning;
    for (const [key, p] of this.pins) {
      const r = this.review.get(key);
      if (r?.state === 'reviewing' && idle && live.ends > r.turn) this.review.set(key, { state: 'returned' });
      if (r) continue;
      this.review.set(key, { state: 'checking' });
      const gen = this.gen;
      const s = open.get(p.ask.sessionId);
      const facts = s?.askCards.get(p.ask.id)?.facts;
      const done = (why: string | null) => {
        if (this.gen !== gen || this.review.get(key)?.state !== 'checking') return;
        this.review.set(key, why ? { state: 'held', why } : { state: 'queued', facts });
        this.dispatch();
        this.changed();
      };
      const check = async () => {
        if (!s) return 'Its session is not open';
        return (await destructive(facts, this.host.roots(s))) ?? (approvalFits(p, facts) ? null : 'Too long to show the commander in full');
      };
      void check().then(done, (err: Error) => done(`Could not be checked: ${err.message}`));
    }
    this.dispatch();
  }

  // Sends the queued asks while the commander is idle, within APPROVAL_BATCH asks and APPROVAL_CHARS characters.
  private dispatch() {
    const live = this.host.live();
    if (!this.auto || !live || live.turnRunning) return;
    const batch: { pin: PinnedAsk; facts?: AskFacts }[] = [];
    let size = 0;
    for (const [key, r] of this.review) {
      const pin = this.pins.get(key);
      if (r.state !== 'queued' || !pin) continue;
      size += approvalText([{ pin, facts: r.facts }]).length;
      if (batch.length && (batch.length >= APPROVAL_BATCH || size > APPROVAL_CHARS)) break;
      batch.push({ pin, facts: r.facts });
    }
    if (!batch.length) return;
    for (const { pin } of batch) this.review.set(pin.id, { state: 'reviewing', turn: live.ends, gen: this.gen });
    live.send(approvalText(batch), [], [], [], false, undefined, undefined, [], { sessionId: batch[0].pin.ask.sessionId, role: 'approval', actor: 'agent' });
  }

  // permission_answer. Only an ask handed to the commander in this generation of the switch, during the turn that
  // followed, can be answered; the checker runs again here, whatever the earlier check said. Allow and deny take the
  // user's buttons' path, never "always allow".
  async answer(s: Session | undefined, askId: string, decision: CmdrDecision, reason: string) {
    const key = `${s?.id} ${askId}`;
    const gen = this.gen;
    const ready = () => {
      if (!this.auto || this.gen !== gen) throw new Error('Auto-approve is off or was switched since, so the user answers this ask. Do not answer it.');
      const a = s?.askCards.get(askId);
      if (!s || !a?.card || !this.pins.has(key)) throw new Error('That ask is no longer waiting: the user or its session settled it.');
      const r = this.review.get(key);
      if (r?.state !== 'reviewing' || r.gen !== gen) throw new Error('That ask was not handed to you in this turn, so it stays with the user.');
      return { s, a };
    };
    const { a } = ready();
    const why = await destructive(a.facts, this.host.roots(s!));
    ready();
    if (why) {
      this.mark(key, { state: 'held', why });
      throw new Error(`${why}. It stays with the user.`);
    }
    if (decision === 'leave') {
      this.mark(key, { state: 'left', why: reason });
      return 'Left with the user; its pin shows your reason.';
    }
    this.answering = { key, reason };
    s!.answerPermission(askId, decision === 'allow', decision === 'deny' ? { feedback: `Denied by the commander session under auto-approve: ${reason}` } : undefined);
    this.answering = null;
    if (s!.askCards.has(askId)) throw new Error('That ask is no longer waiting.');
    return decision === 'allow' ? 'Allowed.' : 'Denied; the session was told your reason.';
  }

  private mark(key: string, r: Review) {
    this.review.set(key, r);
    this.changed();
  }

  // A mark moved outside a tick: the commander's map and any voice call on it follow.
  private changed() {
    const live = this.host.live();
    live?.commanderCallAsks(this.flagged().filter(withUser));
    live?.mapChanged();
  }

  // Pins with their auto-approve state; checking and queued both read as queued.
  private flagged(): PinnedAsk[] {
    return [...this.pins.values()].map((p) => {
      const r = this.review.get(p.id);
      if (!r || r.state === 'returned') return p;
      return { ...p, auto: r.state === 'checking' ? 'queued' : r.state, ...('why' in r ? { why: r.why } : {}) };
    });
  }

  // A restart's cut already noted after the session was last active, in this run or before the restart; by each
  // reference's own time, since a collapsed row keeps its first one.
  private named(id: string, since: number) {
    return this.notes.some((n) => n.note.kind === 'failed' && n.note.refs.some((r) => r.sessionId === id && r.text === INTERRUPTED && r.at >= since));
  }

  private note(kind: 'ask' | 'failed' | 'done', ref: CmdrRef) {
    if (this.group) return;
    const live = this.host.live();
    const last = this.notes.at(-1);
    // Consecutive notes of one kind share a row while nothing else came between them in the conversation. A parked
    // commander's log is not loaded, so that cannot be checked and a new row starts.
    const refs = last && live && 'refs' in last.note && last.note.kind === kind && last.note.refs.length < GROUP_MAX && live.lastNoteId() === last.id ? last.note.refs : null;
    this.put(last && refs ? { ...last, note: { kind, refs: [...refs, ref] } } : { id: `cmdr:${randomUUID()}`, at: Date.now(), note: { kind, refs: [ref] } });
  }

  private put(n: Stored) {
    if (this.stopped) return;
    const i = this.notes.findLastIndex((x) => x.id === n.id);
    if (i >= 0) this.notes[i] = n;
    else if (this.notes.push(n) > NOTES_MAX) this.notes.shift();
    this.host.live()?.pushNote(n.id, n.note);
    this.save();
  }

  // Every event another session logs passes here; the ones that make a relayed card go into the commander's conversation.
  relay(s: Session, e: ServerEvent) {
    if (this.stopped) return;
    if (s.kind === 'commander' || e.type === 'cmdr-relay' || e.type === 'cmdr-relay-end') return;
    this.parentOf(s.id)?.relay(s, e);
    const key = 'id' in e ? `${s.id}:${e.id}` : '';
    switch (e.type) {
      case 'tool': {
        const detail = e.partial || e.fold ? '' : (e.detail?.kind ?? '');
        const kind = ASKS.has(detail) ? 'ask' : VISUALS.has(detail) && this.delegated.has(s.id) ? 'visual' : null;
        if (kind) this.card(s, key, kind, e);
        return;
      }
      case 'permission':
        if (e.questions || e.plan !== undefined) this.card(s, key, 'perm', e);
        return;
      case 'tool-result': {
        const o = this.open.get(key);
        if (!o || o.kind === 'perm') return;
        this.open.delete(key);
        // An ask tool that ends in an error was not answered.
        return this.putRelay(o.kind === 'ask' && e.error ? { type: 'cmdr-relay-end', id: key } : { type: 'cmdr-relay', id: key, from: o.from, event: e });
      }
      case 'permission-resolved':
        if (this.open.get(key)?.kind === 'perm') this.resolved = e;
        return;
      // An interrupted call may never get a result.
      case 'turn-end':
        return this.endRelays(s.id, s.askCards);
    }
  }

  private card(s: Session, key: string, kind: 'ask' | 'perm' | 'visual', event: RelayedEvent) {
    if (this.open.has(key) || !this.host.exists()) return;
    const from = fromOf(s);
    if (this.open.size >= PINS_MAX) {
      this.putRelay({ type: 'cmdr-relay', id: `${s.id}:overflow`, from, event: { type: 'text', id: 'overflow', delta: 'More cards are waiting in their source tabs. Open those tabs to view and answer their live asks.' } });
      return;
    }
    this.open.set(key, { from, kind });
    this.putRelay({ type: 'cmdr-relay', id: key, from, event });
  }

  // A session's relayed asks end unanswered, except those still waiting; its visuals stop expecting a result.
  private endRelays(sessionId: string, waiting?: Map<string, unknown>) {
    for (const [key, o] of this.open) {
      if (o.from.sessionId !== sessionId || (o.kind !== 'visual' && waiting?.has(key.slice(sessionId.length + 1)))) continue;
      this.open.delete(key);
      if (o.kind !== 'visual') this.putRelay({ type: 'cmdr-relay-end', id: key });
    }
    if (this.pruneRelays()) this.save();
  }

  private pruneRelays() {
    let excess = this.relays.length - RELAYS_MAX;
    if (excess <= 0) return false;
    // Scan only through the excess, retaining open cards without rescanning them for each removal.
    let read = 0, keep = 0;
    while (read < this.relays.length && excess > 0) {
      const row = this.relays[read++];
      if (this.open.has(row.id)) this.relays[keep++] = row;
      else excess--;
    }
    if (read === keep) return false;
    this.relays.splice(keep, read - keep);
    return true;
  }

  private putRelay(e: RelayEvent) {
    if (this.stopped) return;
    e = boundedRelay(e);
    this.relays.push({ ...e, at: Date.now() });
    this.pruneRelays();
    // Each of 500 groups fits in the file budget even when every retained card is still open.
    if (Buffer.byteLength(JSON.stringify(this.relays)) > 60_000) this.relays = this.relays.map((r) => boundedRelay(r, true));
    this.host.live()?.pushRelay(e);
    this.save();
  }

  // A pinned ask closed: its pin leaves and one record line stays. A relayed question or plan card closes here too.
  settled(sessionId: string, askId: string, allow: boolean, how: AskSettle) {
    if (this.stopped) return;
    this.parentOf(sessionId)?.settled(sessionId, askId, allow, how);
    const card = `${sessionId}:${askId}`;
    const o = this.open.get(card);
    if (o?.kind === 'perm') {
      const e = this.resolved;
      this.resolved = null;
      this.open.delete(card);
      this.putRelay(how === 'cancelled' || !e ? { type: 'cmdr-relay-end', id: card } : { type: 'cmdr-relay', id: card, from: o.from, event: e });
    }
    const key = `${sessionId} ${askId}`;
    const pin = this.pins.get(key);
    if (!pin) return;
    this.pins.delete(key);
    this.review.delete(key);
    if (this.group) return;
    const by = this.answering?.key === key ? this.answering : null;
    const { tool, command, summary } = pin.ask;
    // A phone answer reaches this side only as a cancel, so its decision is not known here.
    this.put({
      id: `cmdr:${randomUUID()}`, at: Date.now(),
      note: {
        kind: 'answered', ref: { sessionId, name: pin.name, text: '', at: Date.now() }, allow: how === 'phone' ? null : allow, by: by ? 'commander' : how === 'answered' ? 'you' : how,
        tool, command: oneLine(command ?? summary, 300), ...(by ? { reason: oneLine(by.reason, 300) } : {}),
      },
    });
  }

  // The commander moved to the other provider: one divider row stays at that point of its conversation.
  handoff(from: CmdrSide, to: CmdrSide) {
    this.put({ id: `cmdr:${randomUUID()}`, at: Date.now(), note: { kind: 'handoff', from, to } });
  }

  // A session is closing: its asks abort after the next tick has dropped their pins, so each is recorded now.
  closing(sessionId: string) {
    if (this.stopped) return;
    this.parentOf(sessionId)?.closing(sessionId);
    const d = this.delegated.get(sessionId);
    if (d) {
      d.terminal = true;
      if (!d.reported || d.completion) d.notice ??= d.completion?.ready ? d.completion.text : boundedNotice(`Delegated session ${sessionId} was closed before completion could be confirmed. Its work is no longer being watched.`);
      if (this.group) {
        if (d.notice) this.putRelay({ type: 'cmdr-relay', id: `${sessionId}:closed`, from: d.completion?.from ?? { sessionId, name: sessionId, cwd: '' }, event: { type: 'text', id: 'closed', delta: d.notice } });
        this.delegated.delete(sessionId);
      }
      delete d.completion;
      this.save();
    }
    this.endRelays(sessionId);
    for (const p of [...this.pins.values()]) if (p.ask.sessionId === sessionId) this.settled(sessionId, p.ask.id, false, 'cancelled');
  }

  pin(sessionId: string, askId: string) {
    return this.pins.get(`${sessionId} ${askId}`);
  }

  // Keep the last report armed so a late notification turn can report its newer result.
  delegate(target: Session) {
    if (this.stopped) return;
    if (!this.delegated.has(target.id) && this.delegated.size >= DELEGATIONS_MAX) {
      const retired = [...this.delegated].find(([, d]) => d.reported && !d.notice);
      if (!retired) throw new Error('Too many pending delegations; wait for a completion before delegating more work.');
      this.delegated.delete(retired[0]);
    }
    const notice = this.delegated.get(target.id)?.notice;
    this.delegated.set(target.id, { id: target.id, savedId: target.transcriptId ?? target.codexThreadId, end: target.doneAt, human: target.humanInput, ...(notice ? { notice: boundedNotice(notice) } : {}) });
    this.save();
  }

  private wakes(open: Map<string, Session>) {
    if (this.stopped || this.host.on?.() === false) return;
    let retry = false;
    const parked = [...this.host.parked()];
    for (const [id, d] of this.delegated) {
      if (d.terminal && d.completion?.outcome === INTERRUPTED) {
        const c = d.completion;
        if (!this.named(c.from.sessionId, c.at)) this.note('failed', { sessionId: c.from.sessionId, name: c.from.name, text: INTERRUPTED, at: Date.now() });
        delete d.completion;
        this.save();
      }
      const s = open.get(id) ?? [...open.values()].find((s) => d.savedId && (s.transcriptId === d.savedId || s.codexThreadId === d.savedId));
      const tab = parked.find((t) => t.id === id || (d.savedId && (t.transcriptId === d.savedId || t.codexThreadId === d.savedId)));
      if (!d.terminal && s && d.human !== undefined && s.humanInput !== null && s.humanInput !== d.human) {
        d.terminal = true;
        delete d.completion;
        this.save();
      }
      // A restored tab has no process-local end count; its saved completion remains authoritative until new activity.
      if (!d.terminal && s && s.doneAt > d.end && !s.turnRunning && d.completion?.at !== s.doneAt) {
        if (ackEnd(s)) d.end = s.doneAt;
        else {
          const outcome = s.lastEnd === 'ok' ? 'finished' : s.lastEnd === 'stopped' ? 'was stopped before it finished' : 'failed';
          const events = s.eventsAfter(0);
          const last = events.findLast((e) => e.type === 'text' || e.type === 'user');
          const reply = last?.type === 'text' && s.lastEnd === 'ok' ? boundedNotice(events.map((e) => e.type === 'text' && e.id === last.id ? e.delta : '').join('')) : undefined;
          d.completion = { at: s.doneAt, outcome, from: fromOf(s), reply, ready: false, blockers: s.completionBlockers,
            text: boundedNotice(`${wakeText(s, outcome)}\n\nCompletion is inferred from tracked work and a quiet interval. Recognized services and unknown shell commands older than 60 seconds do not block this report; verify the result before calling it complete.`) };
        }
        this.save();
      }
      const c = d.completion;
      if (!d.terminal && c && s) {
        const b = s.completionBlockers;
        if (!c.blockers || c.blockers.background !== b.background || c.blockers.queued !== b.queued || c.blockers.active !== b.active || c.blockers.ask !== b.ask) {
          c.blockers = b;
          this.save();
        }
        if (s.settled && !c.ready) { c.ready = true; c.quiet = Date.now() - (s.doneAt ? QUIET_MS : 0); this.save(); }
        else if (!s.settled && c.ready) { c.ready = false; delete c.quiet; this.save(); }
      }
      // Loading retired completions with lost execution blockers; only a saved deadline wait may resume here.
      if (!d.terminal && c && !s && tab && !tab.interrupted && !c.ready) {
        c.ready = true;
        c.quiet = Date.now();
        this.save();
      }
      if (!d.terminal && !s && ((!tab) || tab.interrupted)) {
        d.terminal = true;
        if (!d.reported || c) d.notice ??= c?.ready ? c.text : boundedNotice(`Delegated session ${id} ${tab ? 'was interrupted by a server restart' : 'was closed or deleted'} before completion could be confirmed.`);
        delete d.completion;
        this.save();
      } else if (!d.terminal && c) {
        if (c.ready && Date.now() - (c.quiet ?? c.at) < QUIET_MS) retry = true;
        if (c.ready && Date.now() - (c.quiet ?? c.at) >= QUIET_MS && !d.notice) {
          d.end = c.at;
          d.reported = true;
          if (s) this.host.log(s, `Delegated task ${c.outcome}.`);
          this.note(c.outcome === 'finished' ? 'done' : 'failed', { sessionId: c.from.sessionId, name: c.from.name, text: c.outcome, at: c.at });
          if (c.reply) this.putRelay({ type: 'cmdr-relay', id: `${id}:completion:${c.at}`, from: c.from, event: { type: 'text', id: `completion:${c.at}`, delta: c.reply } });
          if (!this.group) d.notice = c.text;
          delete d.completion;
          this.save();
        }
      }
      const live = this.host.live();
      if (d.notice && !this.group && live && !live.isClosed) {
        live.send(d.notice, [], [], [], false, undefined, undefined, [], { sessionId: id, role: 'delegated', actor: 'agent' });
        live.commanderCallReport(d.notice);
        delete d.notice;
        this.save();
      }
      if (d.terminal && (!d.notice || this.group)) {
        if (this.group && d.notice) this.putRelay({ type: 'cmdr-relay', id: `${id}:closed`, from: { sessionId: id, name: s?.name ?? tab?.name ?? id, cwd: s?.cwd ?? tab?.cwd ?? '' }, event: { type: 'text', id: 'closed', delta: d.notice } });
        this.delegated.delete(id);
        this.save();
      }
    }
    if (retry && !this.wakeTimer) {
      this.wakeTimer = setTimeout(() => guard('delegation completion', () => {
        this.wakeTimer = null;
        this.wakes(new Map([...this.host.sessions()].map((s) => [s.id, s])));
      }), Math.max(QUIET_MS, tuning().runMs));
      this.wakeTimer.unref();
    }
  }

  // The session's row after a panel change; true only when a name, state or the agent list moved, not on streamed text.
  agentsMoved(s: Session) {
    const c = this.agentRows.get(s.id);
    if (c?.rev === s.panelRev) return false;
    const subs = s.agentBrief();
    const tasks = s.taskBrief();
    const row = subs.length || tasks
      ? { id: s.id, agents: subs.slice(0, AGENTS_MAX).map(({ id, name, state }) => ({ id, name, state })), more: Math.max(0, subs.length - AGENTS_MAX), live: subs.filter((a) => a.state === 'running' || a.state === 'waiting').length, ...(tasks ? { tasks } : {}) }
      : null;
    const json = JSON.stringify(row);
    this.agentRows.set(s.id, { rev: s.panelRev, row: json === c?.json ? c.row : row, json });
    return json !== c?.json;
  }

  // Only the commander's map asks, and only while someone views it.
  rows(): CommanderRows & { auto: boolean } {
    const agents: CmdrAgents[] = [];
    for (const s of this.host.sessions()) {
      this.agentsMoved(s);
      const row = this.agentRows.get(s.id)?.row;
      if (row) agents.push(row);
    }
    return { asks: this.flagged(), agents, auto: this.auto };
  }

  // Seeded history with the stored notes and relayed cards placed by time, so they keep their spot after a reopen or a
  // restart. Those older than the seeded slice go into the earlier history, when the session has one, so each lands exactly once.
  withNotes(events: TimedEvent[], s: Session): TimedEvent[] {
    const kept = mergeTimed(this.relays, this.notes.map((n) => ({ type: 'cmdr-note', id: n.id, note: n.note, at: n.at })));
    const first = events.find((e) => e.at !== undefined)?.at;
    const k = first === undefined ? 0 : kept.findIndex((n) => n.at! >= first);
    const split = k < 0 ? kept.length : k;
    const older = kept.slice(0, split);
    if (!older.length || !s.wrapEarlier((earlier) => mergeTimed(earlier, older))) return mergeTimed(events, kept);
    return mergeTimed(events, kept.slice(split));
  }

  // A new commander conversation starts without the old one's notes and relayed cards.
  resetNotes() {
    if (this.stopped) return;
    this.notes = [];
    this.relays = [];
    this.open.clear();
    this.save();
  }

  // Turned off: open cards end in its conversation and delegated work is forgotten, so turning on starts clean.
  private dropPending() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (!this.open.size && !this.delegated.size) return;
    for (const [key, o] of this.open) if (o.kind !== 'visual') this.putRelay({ type: 'cmdr-relay-end', id: key });
    this.open.clear();
    this.delegated.clear();
    this.save();
  }

  private save() {
    if (this.stopped) return;
    if (this.group) return this.group.save(this.relays);
    if (!LIVE_SERVER || this.saveTimer) return;
    this.saveTimer = setTimeout(() => guard('commander notes save', () => this.flush()), SAVE_MS);
  }

  async flush(): Promise<void> {
    if (this.group || !LIVE_SERVER) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const batch: [string, string][] = [[NOTES_FILE, JSON.stringify(this.notes)], [RELAYS_FILE, JSON.stringify(this.relays)], [GROUP_RELAYS_FILE, JSON.stringify([...this.groupRelays].map(([id, rows]) => ({ id, rows })))], [DELEGATIONS_FILE, JSON.stringify([...this.delegationScopes].map(([scope, rows]) => ({ scope, rows: [...rows.values()] })))]];
    this.writing = this.writing.then(async () => {
      await mkdir(CACHE_DIR, { recursive: true });
      for (const [file, text] of batch) {
        const tmp = tmpName(file);
        await writeFile(tmp, text, { mode: 0o600 });
        await rename(tmp, file);
      }
    }).catch((err: Error) => console.log(`commander: saving its notes failed (${err.message})`));
    await this.writing;
  }

  // Call after session shutdown mutations; no late timer or callback may change the final snapshot.
  finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    return this.finishing = Promise.all([...this.groupWatches.values()].map((watch) => watch.finish())).then(async () => {
      await this.flush();
      CommanderWatch.roots.delete(this);
    });
  }
}
