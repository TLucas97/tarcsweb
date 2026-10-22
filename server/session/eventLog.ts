import type { FindHit, SeqEvent, ServerEvent, TimedEvent } from '../protocol.ts';
import { ColdLog, FIND_MAX, hitOf, mergeHits, trimPoint } from '../coldLog.ts';
import { fullText } from '../stretch.ts';
import { tuning } from '../profile.ts';
import { guard } from './util.ts';

// Enough recent messages for a cheap explanation to know what the excerpt refers to.
const RECENT_CHARS = 12_000;

export type EventLogHost = {
  id: string;
  // A new log entry; true when it changed the active skills.
  note: (e: ServerEvent) => boolean;
  mapChanged: () => void;
};

// The session's event log: in memory, spilled to disk past the profile's cap, paged and searched back.
export class EventLog {
  private host: EventLogHost;
  // Older events move to disk at the profile's cap, cut near a prompt so turns stay whole.
  private log: SeqEvent[] = [];
  private cold: ColdLog | null = null;
  // Events leave memory only once their write succeeded; one write at a time, and after a failure
  // the next try waits for the log to reach retryAt. Past 2x logMax the oldest go, with one notice.
  private spilling = false;
  private spillRetryAt = 0;
  private spillLost = false;
  // The newest prompt that went to disk, so recentText still has it when a long turn outgrows the log.
  private spilledPrompt: SeqEvent | null = null;
  // Events before the resumed ones (a transcript's segments before its last compaction, a Codex thread's older turns):
  // seqs up to 0, read on the first page or search that needs them.
  earlier: (() => Promise<TimedEvent[]>) | null = null;
  private pre: Promise<ColdLog | null> | null = null;
  // For a merged text entry: the seq of each chunk it holds and where that chunk starts in delta.
  private textCuts = new WeakMap<SeqEvent, { seq: number; at: number }[]>();
  private seq = 0;
  private listeners = new Set<(e: SeqEvent) => void>();
  private textBuf = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: EventLogHost) {
    this.host = host;
  }

  get listening() {
    return this.listeners.size > 0;
  }

  // Past messages go into the log before anyone subscribes.
  seed(events: TimedEvent[]) {
    for (const e of events) {
      this.log.push({ ...e, seq: ++this.seq, sessionId: this.host.id } as SeqEvent);
      this.host.note(e);
    }
    this.spill();
  }

  // Never takes the last entry, which streaming text still merges into.
  private spill() {
    const { logMax, logKeep } = tuning();
    if (this.spilling || this.log.length <= Math.max(logMax, this.spillRetryAt)) return;
    const cut = trimPoint(this.log);
    if (!cut) return;
    if (this.spillRetryAt && this.log.length > 2 * logMax) {
      const lost = this.log.splice(0, cut);
      this.spilledPrompt = lost.findLast((e) => e.type === 'user') ?? this.spilledPrompt;
      this.spillRetryAt = 0;
      console.error(`session ${this.host.id}: history spill keeps failing; dropped ${lost.length} older events from memory`);
      if (this.spillLost) return;
      this.spillLost = true;
      // Not inside emit(), so the notice never lands ahead of the event being pushed.
      queueMicrotask(() => this.push({ type: 'error', message: 'Older messages could not be saved to disk, so the oldest part of this conversation no longer shows in this tab.' }));
      return;
    }
    // A streaming call's partial frames are dropped once it finishes, so they never go to disk.
    const out = this.log.slice(0, cut).filter((e) => !(e.type === 'tool' && e.partial));
    const top = this.log[cut - 1].seq;
    const cold = (this.cold ??= new ColdLog(this.host.id));
    this.spilling = true;
    void cold.append(out).then((ok) => {
      this.spilling = false;
      if (this.cold !== cold) return;
      if (!ok) {
        this.spillRetryAt = this.log.length + (logMax - logKeep);
        return;
      }
      this.spillRetryAt = 0;
      this.spilledPrompt = out.findLast((e) => e.type === 'user') ?? this.spilledPrompt;
      // By seq: dropPartials may have filtered the array while the write ran.
      const keep = this.log.findIndex((e) => e.seq > top);
      this.log.splice(0, keep < 0 ? this.log.length : keep);
      this.spill();
    });
  }

  // Seq of the newest event handed to disk; memory events at or below it are on their way there.
  private get coldTop() {
    return this.cold?.top ?? 0;
  }

  // What a client that has everything up to `seq` is missing. One whose next events already went to disk
  // starts over from the in-memory tail (replace), with the cursor for paging back.
  backlog(seq: number) {
    const top = this.coldTop;
    const replace = seq === 0 || seq < top;
    const events = this.eventsAfter(replace ? top : seq);
    const more = !!this.cold?.size || !!this.earlier;
    return { events, replace, older: replace && more ? (this.log.find((e) => e.seq > top)?.seq ?? this.seq + 1) : null };
  }

  private prehistory() {
    const load = this.earlier;
    if (!load) return Promise.resolve(null);
    return (this.pre ??= (async () => {
      const events = await load();
      if (!events.length) return null;
      const log = new ColdLog(`${this.host.id}.pre`);
      log.append(events.map((e, i) => ({ ...e, seq: i + 1 - events.length, sessionId: this.host.id }) as SeqEvent));
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
    await this.cold?.settled();
    // Only after a failed spill: events below `before` that never reached disk are still in memory.
    const top = this.coldTop;
    const mem = this.log.filter((e) => e.seq > top && e.seq < before);
    if (!mem.length) return this.historyDisk(before, until, id);
    const has = id !== undefined ? mem.some((e) => (e as { id?: string }).id === id) : until === undefined || until >= mem[0].seq;
    if (has) return { events: mem, older: this.cold?.size || this.earlier ? mem[0].seq : null };
    const rest = await this.historyDisk(mem[0].seq, until, id);
    return rest.events.length ? { events: [...rest.events, ...mem], older: rest.older } : { events: [], older: id === undefined ? rest.older : before };
  }

  private async historyDisk(before: number, until?: number, id?: string): Promise<{ events: SeqEvent[]; older: number | null }> {
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
    // Memory events at or below top were written by now and searched on disk.
    const top = this.coldTop;
    for (const e of this.log) {
      if (e.seq <= top) continue;
      const h = hitOf(e, q);
      if (h) hits.push(h);
    }
    return { hits: mergeHits(hits), more: hits.reduce((a, h) => a + h.n, 0) > FIND_MAX };
  }

  subscribe(fn: (e: SeqEvent) => void) {
    this.listeners.add(fn);
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

  recentUser(id: string) {
    for (let i = this.log.length - 1; i >= Math.max(0, this.log.length - 500); i--) {
      const e = this.log[i];
      if (e.type === 'user' && e.id === id) return e;
    }
    return null;
  }

  push(e: ServerEvent) {
    // Keep order: buffered text goes out before whatever comes next.
    this.flushText();
    this.emit(e);
  }

  private emit(e: ServerEvent) {
    const last = this.log[this.log.length - 1];
    const merge = e.type === 'text' && last?.type === 'text' && last.id === e.id;
    // Only a block's first chunk carries at; text chunks are the most frequent events.
    const ev = { ...e, seq: ++this.seq, sessionId: this.host.id } as SeqEvent;
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
      if (this.host.note(e)) this.host.mapChanged();
    }
    for (const fn of this.listeners) fn(ev);
  }

  appendText(id: string, delta: string) {
    this.textBuf.set(id, (this.textBuf.get(id) ?? '') + delta);
    this.flushTimer ??= setTimeout(() => guard('text flush', () => this.flushText()), tuning().flushMs);
  }

  private flushText() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.textBuf.size) return;
    const batch = [...this.textBuf];
    this.textBuf.clear();
    for (const [id, delta] of batch) this.emit({ type: 'text', id, delta });
  }

  // A finished streaming call's partial frames leave the log.
  dropPartials(id: string) {
    this.log = this.log.filter((e) => !(e.type === 'tool' && e.partial && e.id === id));
  }

  // The conversation's last user and Claude messages, newest kept whole, up to a character budget.
  recentText(budget = RECENT_CHARS) {
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

  close() {
    this.cold?.drop();
    void this.pre?.then((p) => p?.drop());
  }
}
