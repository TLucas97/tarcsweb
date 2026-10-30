import { randomUUID, type UUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { HandoffPhase, HandoffState, Provider, ServerEvent, Status, TextLink, Upload } from '../protocol.ts';
import { HANDOFF_PREFIX, SWITCH_PREFIX, TRANSFER_PREFIX } from '../protocol.ts';
import { fullText } from '../stretch.ts';
import { handoffAt } from '../config.ts';
import { oneLine } from '../text.ts';
import { guard } from './util.ts';

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
// Deadlines for compaction completion and hand-over acceptance; resumed work has no handoff deadline.
const COMPACT_MS = 10 * 60_000;
const HAND_OVER_MS = 5 * 60_000;

export type HandoffDoc = { path: string; text: string };
export type Held = { text: string; pastes: string[]; files: Upload[]; thumbs: (string | null)[]; cid?: string; links?: TextLink[]; origin?: import('../protocol.ts').SessionOrigin };

export async function saveHandoff(id: string, text: string): Promise<HandoffDoc> {
  await mkdir(HANDOFF_DIR, { recursive: true });
  const path = `${HANDOFF_DIR}/handoff-${id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  await writeFile(path, text);
  return { path, text };
}

export type HandoffHost = {
  id: string;
  provider: () => Provider;
  resumeId: () => string | null;
  persisted: () => boolean;
  codexThreadId: () => string | null;
  status: () => Status;
  setStatus: (s: Status) => void;
  ctxUsed: () => number | null;
  // A permission card or question is waiting on the user.
  waiting: () => boolean;
  agentsRunning: () => boolean;
  // Pushes a prompt that opens a turn of its own.
  startTurn: (uuid: UUID, text: string) => void;
  q: () => Query | null;
  requestStop: () => void;
  push: (e: ServerEvent) => void;
  chapter: (id: string, label: string) => void;
  send: (h: Held) => void;
  sendText: (text: string, origin?: import('../protocol.ts').SessionOrigin) => void;
  flushCodexHeld: () => void;
  // The live CLI's options, with no brokers, for the fork that writes the doc.
  baseOptions: () => Options;
  codexHandoff: (prompt: string, signal: AbortSignal) => Promise<{ text: string; ephemeral: boolean }>;
  nameSwitched: (name: string) => void;
  mapChanged: () => void;
  onChange: () => void;
};

// The context handoff and the provider switch: write a doc, compact, hand it to the next turn or tab.
export class Handoff {
  private host: HandoffHost;
  state: HandoffState | null = null;
  // A written doc kept for the retry when a later phase failed.
  private doc: HandoffDoc | null = null;
  private tries = 0;
  private post: number | null = null;
  private abortCtl: AbortController | null = null;
  // Resolved by the /compact result, then the hand-over prompt's lifecycle 'started'.
  // started flips on the command's lifecycle 'started', so a result from a turn that ran before it is not taken for its own.
  private wait: { uuid: string; started: boolean; resolve: () => void; reject: (err: Error) => void } | null = null;
  // The last TodoWrite or show_plan still had a step not done; a handoff then tells the agent to go on.
  planOpen = false;
  private compactedNow = false;
  private held: Held[] = [];
  // Messages moved here by a provider switch; they go out when the seed turn ends.
  afterSeed: Held[] = [];

  constructor(host: HandoffHost) {
    this.host = host;
  }

  get running() {
    const p = this.state?.phase;
    return p === 'writing' || p === 'compacting' || p === 'handing';
  }

  // The result being handled answers the turn this handoff pushed.
  get ours() {
    return !!this.wait?.started;
  }

  // Past the threshold at a turn end: hand off, unless a prompt may still be queued or the last compaction freed too little.
  maybe(queued: boolean) {
    const used = this.host.ctxUsed() ?? 0;
    const at = handoffAt();
    if (at === null || used < at) {
      this.tries = 0;
      this.doc = null;
      return;
    }
    if (queued || this.host.status() === 'working' || this.running || !this.host.resumeId() || this.tries >= HANDOFF_TRIES) return;
    // Background work reports with a new turn; the turn end after it tries again. A dev server left running does not block it.
    if (this.host.waiting() || this.host.agentsRunning()) return;
    if (this.post !== null && used < this.post + HANDOFF_GAIN) return;
    void this.run(used);
  }

  private set(patch: Partial<HandoffState>, phase?: HandoffPhase) {
    if (!this.state) return;
    const now = Date.now();
    const next = { ...this.state, ...patch };
    if (phase) {
      next.phase = phase;
      next.steps = { ...next.steps, [phase]: now };
      if (phase === 'done' || phase === 'failed') next.endedAt = now;
    }
    this.state = next;
    this.host.mapChanged();
    this.host.onChange();
  }

  // Waits for compaction completion or hand-over acceptance; past ms the handoff fails.
  private turn(text: string, ms: number, late: string) {
    return new Promise<void>((resolve, reject) => {
      const uuid = randomUUID();
      const timer = setTimeout(() => guard('handoff deadline', () => {
        if (this.wait?.uuid === uuid) this.stopWait(new Error(late));
      }), ms);
      this.wait = {
        uuid, started: false,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.host.startTurn(uuid, text);
    });
  }

  // Fails the pending wait and takes its prompt back from the CLI: out of the queue, or by stopping its turn.
  private stopWait(err: Error) {
    const w = this.wait;
    if (!w) return;
    this.wait = null;
    w.reject(err);
    const q = this.host.q() as (Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }) | null;
    if (!w.started) return void q?.cancelAsyncMessage?.(w.uuid).catch(() => false);
    this.host.requestStop();
    void q?.interrupt().catch(() => {});
  }

  // The card's "Try again" and the tab menu's "Hand off now": skips the tries cap and the gain guard. Returns why it can't.
  now(): string | null {
    if (this.host.provider() === 'codex') return 'Codex compacts the conversation on its own';
    if (this.running) return 'A handoff is already running';
    if (!this.host.resumeId()) return 'Nothing to hand off yet; send a message first';
    if (this.host.status() === 'working' || this.host.waiting()) return 'Session is busy, try again when it finishes';
    void this.run(this.host.ctxUsed() ?? null);
    return null;
  }

  // The card's close button: a live handoff stops and ends failed ("Stopped"); a finished card clears in every window.
  dismiss() {
    if (!this.state) return;
    if (!this.running) {
      this.state = null;
      this.host.mapChanged();
      return;
    }
    this.abortCtl?.abort();
    this.stopWait(new Error('Stopped'));
  }

  private async run(pre: number | null) {
    // Decided before the compaction, which drops what the agent was doing.
    const midTask = this.planOpen || this.host.agentsRunning();
    const now = Date.now();
    this.state = {
      phase: 'writing', steps: { writing: now }, startedAt: now, endedAt: null, pre, post: null, path: this.doc?.path ?? null, error: null, held: [],
    };
    this.abortCtl = new AbortController();
    this.compactedNow = false;
    this.host.mapChanged();
    this.host.onChange();
    try {
      const doc = this.doc ?? (this.doc = await this.write(this.abortCtl));
      this.set({ path: doc.path }, 'compacting');
      await this.turn(`/compact ${COMPACT_INSTRUCTIONS}`, COMPACT_MS, 'The compaction took more than 10 minutes');
      this.set({}, 'handing');
      const lead = midTask ? 'Continue the work from it, together with the compaction summary above.' : 'Read it together with the compaction summary above; it is the context for the next message.';
      const text = [`${HANDOFF_PREFIX}${doc.path}.`, lead, '', doc.text, '', '---', midTask ? HANDOFF_GO_ON : HANDOFF_TAIL].join('\n');
      const id = randomUUID();
      this.host.push({ type: 'user', id, text });
      this.host.chapter(id, 'Context handoff');
      await this.turn(text, HAND_OVER_MS, 'Claude Code did not start the hand-over turn within 5 minutes');
      this.doc = null;
      this.tries = 0;
      this.post = this.state?.post ?? this.host.ctxUsed() ?? null;
      this.set({}, 'done');
    } catch (err) {
      this.tries++;
      const aborted = this.abortCtl?.signal.aborted;
      this.set({ error: aborted ? 'Stopped' : err instanceof Error ? err.message : String(err) }, 'failed');
      if (this.host.status() === 'working' && !this.wait) this.host.setStatus('idle');
    } finally {
      this.abortCtl = null;
      this.wait = null;
      const held = this.held;
      this.held = [];
      for (const h of held) this.host.send(h);
      this.host.flushCodexHeld();
    }
  }

  // A throwaway fork of the transcript writes the doc. Tools are denied; the spare turns let it answer after a denied call.
  private async write(abort: AbortController): Promise<HandoffDoc> {
    const id = this.host.resumeId()!;
    const fork = query({
      prompt: `${HANDOFF_PROMPT}\n\nDo not call any tool or skill here. Answer with the handoff document itself, as plain text.`,
      options: {
        ...this.host.baseOptions(),
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
    const provider = this.host.provider();
    if (to === provider) throw new Error(`This tab already runs on ${to === 'codex' ? 'Codex' : 'Claude'}`);
    if (this.running) throw new Error('A handoff is already running');
    if (this.host.status() === 'working' || this.host.waiting()) throw new Error('Session is busy, try again when it finishes');
    if (provider === 'claude' ? !this.host.persisted() || !this.host.resumeId() : !this.host.codexThreadId()) throw new Error('Nothing to hand off yet; send a message first');
    const now = Date.now();
    this.state = {
      phase: 'writing', steps: { writing: now }, startedAt: now, endedAt: null, pre: this.host.ctxUsed() ?? null, post: null, path: null, error: null, held: [], to, tab: null,
    };
    const abort = (this.abortCtl = new AbortController());
    this.host.mapChanged();
    this.host.onChange();
    try {
      const doc = provider === 'claude' ? await this.write(abort) : await this.writeCodex(abort.signal);
      if (abort.signal.aborted) throw new Error('Stopped');
      this.set({ path: doc.path }, 'handing');
      return doc;
    } catch (err) {
      this.switchFailed(err);
      throw err;
    }
  }

  private async writeCodex(signal: AbortSignal): Promise<HandoffDoc> {
    const prompt = `${HANDOFF_PROMPT}\n\nDo not call any tool or skill here. Answer with the handoff document itself, as plain text.`;
    const { text, ephemeral } = await this.host.codexHandoff(prompt, signal);
    console.info(`[codex] handoff written by ${ephemeral ? 'an ephemeral fork' : 'a saved fork, now hidden and archived'}`);
    return saveHandoff(this.host.codexThreadId() ?? this.host.id, text);
  }

  // The new tab is open; what was typed here meanwhile goes there, and this card points at it.
  switched(tab: string): Held[] {
    const held = this.held;
    this.held = [];
    this.abortCtl = null;
    this.set({ tab }, 'done');
    this.host.flushCodexHeld();
    return held;
  }

  switchFailed(err: unknown) {
    if (!this.state || this.state.phase === 'failed') return;
    const aborted = this.abortCtl?.signal.aborted;
    this.abortCtl = null;
    this.set({ error: aborted ? 'Stopped' : err instanceof Error ? err.message : String(err) }, 'failed');
    const held = this.held;
    this.held = [];
    for (const h of held) this.host.send(h);
    this.host.flushCodexHeld();
  }

  // A tab opened by a provider switch: its first turn reads the handoff; messages held meanwhile follow once that turn ends.
  // With an instruction it is a transfer instead: the source keeps running beside it.
  seedSwitch(doc: HandoffDoc, from: Provider, name: string, held: Held[], instruction?: string, origin?: import('../protocol.ts').SessionOrigin) {
    if (instruction === undefined) this.host.nameSwitched(name);
    const who = from === 'claude' ? 'Claude' : 'Codex';
    const text = instruction === undefined
      ? [`${SWITCH_PREFIX}${doc.path}.`, `${who} held this conversation until now and wrote it for you. Continue the work from it.`, '', doc.text, '', '---', HANDOFF_TAIL].join('\n')
      : [`${TRANSFER_PREFIX}${doc.path}.`, `The session "${name}" wrote it for you and keeps running.`, '', doc.text, '', '---', instruction].join('\n');
    this.afterSeed = held;
    this.host.sendText(text, origin);
  }

  // A message sent while the handoff runs waits for it; false when none runs.
  hold(h: Held) {
    if (!this.running || !this.state) return false;
    if (h.cid && this.held.some((x) => x.cid === h.cid)) return true;
    this.held.push(h);
    const preview = oneLine(h.text || h.files.map((f) => f.name).join(', ') || 'Pasted text', 80);
    this.state = { ...this.state, held: [...this.state.held, preview] };
    this.host.mapChanged();
    return true;
  }

  abort() {
    this.abortCtl?.abort();
  }

  // Ends a pending wait; clear drops it at once instead of leaving it for the run's own cleanup.
  failWait(why: string, clear: boolean) {
    const w = this.wait;
    if (clear) this.wait = null;
    w?.reject(new Error(why));
  }

  // A command's lifecycle: the pushed prompt started, or the CLI never took it.
  lifecycle(uuid: string | undefined, state: string | undefined) {
    const w = this.wait;
    if (!w || uuid !== w.uuid) return;
    if (state === 'started') {
      w.started = true;
      // A background turn's result may have set idle while this command waited in the queue.
      this.host.setStatus('working');
      if (this.state?.phase === 'handing') {
        this.wait = null;
        w.resolve();
      }
    } else if (state === 'cancelled' || state === 'discarded' || state === 'refused') {
      this.wait = null;
      w.reject(new Error(state === 'cancelled' ? 'The handoff was stopped' : 'Claude Code did not take the handoff'));
    }
  }

  // The /compact command's own result is not a turn of the conversation.
  isCompactResult(ours: boolean) {
    return this.state?.phase === 'compacting' && !!this.wait && ours;
  }

  compactResult(ok: boolean, compactError: string | null) {
    const w = this.wait!;
    this.wait = null;
    if (this.compactedNow) w.resolve();
    else w.reject(new Error(compactError ?? (ok ? 'The compaction did not run' : 'The compaction was stopped')));
  }

  compacted(pre: number, post: number | null) {
    if (!this.state) return;
    this.compactedNow = true;
    this.state = { ...this.state, pre, post };
  }
}
