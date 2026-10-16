import { appendFile, mkdir, open, readdir, rm, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';
import type { FindHit, SeqEvent, ToolDetail } from './protocol.ts';

// A session keeps its newest events in memory; past LOG_MAX the oldest go to disk, leaving about LOG_KEEP.
export const LOG_MAX = 800;
export const LOG_KEEP = 400;
// Events per history page, and how much further back a page may reach to start at a prompt.
const PAGE = 300;
const PAGE_REACH = 600;
// Matches a search reports at most.
export const FIND_MAX = 2000;

// One folder per server process, so a second server on the same cache (a boot check) never deletes this one's files.
const ROOT = join(CACHE_DIR, 'history');
const DIR = join(ROOT, String(process.pid));
let made: Promise<unknown> | null = null;

// Where a page may start: 2 a prompt (the cleanest cut), 1 the first chunk of a reply, 0 anywhere else.
export type Kind = 0 | 1 | 2;
export function kindOf(e: SeqEvent, i: number, list: readonly SeqEvent[]): Kind {
  if (e.type === 'user') return 2;
  const prev = list[i - 1];
  return e.type === 'text' && !(prev?.type === 'text' && prev.id === e.id) ? 1 : 0;
}

// The nearest cut at `at`: a prompt first, then a reply start; looks back to `low`, then forward up to `high`.
function snap(kinds: ArrayLike<number>, at: number, low: number, high: number) {
  for (const k of [2, 1]) {
    for (let i = at; i >= low; i--) if (kinds[i] === k) return i;
    for (let i = at + 1; i < high; i++) if (kinds[i] === k) return i;
  }
  return at;
}

// Where the in-memory log is cut: about LOG_KEEP events from the end, at a prompt when one is close, so a turn stays whole.
export function trimPoint(log: readonly SeqEvent[]) {
  const at = log.length - LOG_KEEP;
  if (at <= 0) return 0;
  return snap(log.map(kindOf), at, Math.max(1, at - (LOG_MAX - LOG_KEEP) / 2), log.length - LOG_KEEP / 2);
}

// Start index of the page that ends before `end`; it reaches back to `until` when that is set.
export function pageStart(kinds: ArrayLike<number>, end: number, until = -1) {
  const at = until >= 0 ? Math.min(until, end - PAGE) : end - PAGE;
  if (at <= 0) return 0;
  return snap(kinds, at, Math.max(0, at - PAGE_REACH), until >= 0 ? until + 1 : end);
}

function detailParts(d: ToolDetail | undefined): string[] {
  switch (d?.kind) {
    case 'visual': case 'replay': return [d.title];
    case 'chart': return [d.chart.title];
    case 'table': return [d.table.title, d.table.note, ...d.table.columns, ...d.table.rows.flat()];
    case 'plan': return [d.plan.title, ...d.plan.steps.map((s) => s.text)];
    case 'choice': return [d.choice.question, ...d.choice.options.map((o) => `${o.label} ${o.description}`)];
    case 'round': return [d.round.title, ...d.round.questions.map((q) => `${q.title} ${q.setup}`)];
    default: return [];
  }
}

// Parts the row shows once even when the event repeats them (a diff path is the summary, a title often is too).
function once(main: string, extra: (string | undefined)[]) {
  const low = main.toLowerCase();
  return [main, ...extra.filter((p) => p && !low.includes(p.toLowerCase()))].join(' ');
}

// The row id and text an event shows in the conversation, as the client keys it; null when it shows no text.
function textOf(e: SeqEvent): [string, string] | null {
  switch (e.type) {
    case 'user': return [e.id, e.files?.length ? `${e.text} ${e.files.map((f) => f.name).join(' ')}` : e.text];
    case 'text': return [e.id, e.delta];
    case 'tool': return e.fold || e.partial ? null : [e.id, once(`${e.verb} ${e.summary}`, detailParts(e.detail))];
    case 'permission': return [e.id, once(`${e.tool} ${e.summary}`, [e.title])];
    case 'error': return [`err-${e.seq}`, e.message];
    case 'tldr': case 'tool-note': return [e.id, e.text];
    default: return null;
  }
}

// sums: the event adds its own text to the row (a reply's chunks, its summary, a note); else it repeats the row's text.
type Hit = FindHit & { sums: boolean };

// Case-insensitive matches of a lowercase needle in one event.
export function hitOf(e: SeqEvent, q: string): Hit | null {
  const t = textOf(e);
  if (!t) return null;
  const low = t[1].toLowerCase();
  let n = 0;
  for (let i = low.indexOf(q); i !== -1; i = low.indexOf(q, i + q.length)) n++;
  return n ? { id: t[0], seq: e.seq, n, sums: e.type === 'text' || e.type === 'tldr' || e.type === 'tool-note' } : null;
}

// Joins hits on the same row, oldest first. The cap keeps the newest FIND_MAX matches, nearest the reader.
export function mergeHits(hits: Hit[]) {
  // rep: the most matches of one repeating event (a call and its permission card); own: the sum of the rest.
  const by = new Map<string, { seq: number; rep: number; own: number }>();
  let total = 0;
  for (let i = hits.length - 1; i >= 0 && total < FIND_MAX; i--) {
    const h = hits[i];
    const row = by.get(h.id) ?? { seq: h.seq, rep: 0, own: 0 };
    by.set(h.id, row);
    const was = row.rep + row.own;
    if (h.sums) row.own += h.n;
    else row.rep = Math.max(row.rep, h.n);
    row.seq = Math.min(row.seq, h.seq);
    total += row.rep + row.own - was;
  }
  return [...by].map(([id, r]): FindHit => ({ id, seq: r.seq, n: r.rep + r.own })).sort((a, b) => a.seq - b.seq);
}

// Deletes the folders of servers no longer running; a live server's folder stays.
export async function sweepCold() {
  for (const name of await readdir(ROOT).catch(() => [] as string[])) {
    const pid = Number(name);
    if (pid === process.pid || (Number.isInteger(pid) && alive(pid))) continue;
    await rm(join(ROOT, name), { recursive: true, force: true }).catch(() => {});
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Events trimmed off a session's log, as JSON lines on disk. Only offsets stay in memory; pages and searches read the file.
export class ColdLog {
  private path: string;
  // Indexes of what is safely on disk, set once each write resolves, so a failed write never shifts them.
  private seqs: number[] = [];
  // offs[i] is where line i starts; the last entry is the file size.
  private offs: number[] = [0];
  private kinds: Kind[] = [];
  private lastText: string | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  // Counted when queued, so the session knows at once what left its memory.
  private queued = 0;
  private first = Infinity;
  private last = 0;

  // A name per instance: a closing session's unlink must not hit a newer one with the same id.
  constructor(name: string) {
    this.path = join(DIR, `${name}.${++files}.jsonl`);
  }

  get size() {
    return this.queued;
  }

  // The newest seq handed over; 0 when empty.
  get top() {
    return this.last;
  }

  get bottom() {
    return this.first;
  }

  append(events: SeqEvent[]) {
    if (!events.length) return;
    this.queued += events.length;
    this.first = Math.min(this.first, events[0].seq);
    this.last = events[events.length - 1].seq;
    const lines = events.map((e) => JSON.stringify(e) + '\n');
    this.writing = this.writing.then(async () => {
      const at = this.offs[this.offs.length - 1];
      try {
        await (made ??= mkdir(DIR, { recursive: true, mode: 0o700 }));
        await appendFile(this.path, lines.join(''), { mode: 0o600 });
      } catch (err) {
        console.error('history spill failed:', err);
        made = null;
        // Cut back any partial write so the file keeps matching the offsets.
        await truncate(this.path, at).catch(() => {});
        return;
      }
      let off = at;
      events.forEach((e, i) => {
        this.seqs.push(e.seq);
        this.kinds.push(e.type === 'user' ? 2 : e.type === 'text' && e.id !== this.lastText ? 1 : 0);
        this.lastText = e.type === 'text' ? e.id : null;
        this.offs.push((off += Buffer.byteLength(lines[i])));
      });
    });
  }

  // The page of events older than seq `before`; until (a seq) or id (an event id) stretch it back to include that event.
  // found is false when id is not on disk; nothing is read beyond the search then.
  async page(before: number, until?: number, id?: string): Promise<{ events: SeqEvent[]; older: number | null; found: boolean }> {
    await this.writing;
    const end = this.indexOfSeq(before);
    if (id !== undefined) {
      const key = `"id":${JSON.stringify(id)}`;
      const lines = await this.read(0, end);
      const at = lines.findIndex((l) => l.includes(key));
      if (at < 0) return { events: [], older: before, found: false };
      const start = pageStart(this.kinds, end, at);
      return { events: parse(lines.slice(start)), older: start > 0 ? this.seqs[start] : null, found: true };
    }
    const start = pageStart(this.kinds, end, until !== undefined ? Math.min(this.indexOfSeq(until), end - 1) : -1);
    return { events: parse(await this.read(start, end)), older: start > 0 ? this.seqs[start] : null, found: true };
  }

  // Every match on disk, oldest first. A line is parsed only when its raw JSON holds the needle.
  async find(q: string): Promise<Hit[]> {
    await this.writing;
    const raw = JSON.stringify(q).slice(1, -1);
    const out: Hit[] = [];
    for (const e of parse((await this.read(0, this.seqs.length)).filter((l) => l.toLowerCase().includes(raw)))) {
      const h = hitOf(e, q);
      if (h) out.push(h);
    }
    return out;
  }

  drop() {
    this.writing = this.writing.then(() => {
      this.seqs = [];
      this.offs = [0];
      this.kinds = [];
      return unlink(this.path);
    }).catch(() => {});
  }

  // First index whose seq is at least `seq`.
  private indexOfSeq(seq: number) {
    let lo = 0;
    let hi = this.seqs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.seqs[mid] < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Lines a to b as raw JSON, read only within the indexed bytes.
  private async read(a: number, b: number): Promise<string[]> {
    if (a >= b) return [];
    const fh = await open(this.path, 'r');
    try {
      const len = this.offs[b] - this.offs[a];
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.offs[a]);
      return buf.toString('utf8', 0, bytesRead).split('\n').filter(Boolean);
    } finally {
      await fh.close();
    }
  }
}

let files = 0;

// A damaged line is skipped instead of failing the whole page or search.
function parse(lines: string[]) {
  const out: SeqEvent[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as SeqEvent);
    } catch {}
  }
  return out;
}
