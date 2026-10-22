import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { firstSentence, goalOf, noteLabel, type AgentState, type WatchEntry, type WatchPage, type WatchSub } from './protocol.ts';
import { APP_TOOLS, CODEX_TOOLS, PLUMBING, PROGRESS_TOOL, planOf, resultText, summarizeFor, verbOf } from './tools.ts';
import { fileDelta } from './agents.ts';
import { displayPath, failBrief, oneLine } from './text.ts';
import { FILE_TEXT, NOISE, slashOf, type Block } from './history.ts';

// Entries kept per session (oldest dropped first), entries per watch-load reply, and calls awaiting a result.
const KEEP = 20_000;
const PAGE = 2_000;
const OPEN_MAX = 500;
const CHUNK = 1 << 20;
const SUMMARY_MAX = 120;
// Per subagent transcript: entries kept (newest), and sub logs kept per session; the subagents folder is rescanned at most this often.
const SUB_KEEP = 200;
const SUBS_MAX = 256;
const SCAN_MS = 1000;
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode', APP_TOOLS.choice, APP_TOOLS.round]);
const NOTE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const NOTE_STATUS = /<status>([^<]+)<\/status>/;

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
type Line = {
  type?: string; uuid?: string; isSidechain?: boolean; isMeta?: boolean; isApiErrorMessage?: boolean; isCompactSummary?: boolean;
  timestamp?: string; message?: { model?: string; content?: unknown }; toolUseResult?: unknown; attachment?: unknown;
};

export const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

// The CLI names a project folder after its cwd with every non-alphanumeric character as '-'; long paths get hashed, so search then.
export async function transcriptPath(cwd: string, id: string) {
  const file = `${id}.jsonl`;
  const direct = join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, '-'), file);
  if (await stat(direct).then(() => true, () => false)) return direct;
  for (const dir of await readdir(projectsDir()).catch(() => [] as string[])) {
    const p = join(projectsDir(), dir, file);
    if (await stat(p).then(() => true, () => false)) return p;
  }
  return null;
}

// Watch mode's timeline of one transcript. Reads only bytes appended since the last load, without sync fs.
// Includes every line in file order, so work on a rewound branch shows too.
// A sub timeline reads one subagent's transcript (<session>/subagents/agent-*.jsonl): its calls, narration and progress notes.
export class WatchTimeline {
  readonly id: string;
  private cwd: string;
  private path: string | null = null;
  private sub: boolean;
  private keep: number;
  private offset = 0;
  // entries[i] has cursor base + i; capped at keep. dropped counts the calls among the trimmed ones.
  private entries: WatchEntry[] = [];
  private base = 0;
  private dropped = 0;
  private open = new Map<string, WatchEntry>();
  // A prompt opened a turn that no later prompt or interrupt closed yet.
  private inTurn = false;
  private lastAt: number | null = null;
  private ends = 0;
  private syncing: Promise<void> | null = null;
  // Sub only: when each entry was added or last settled, for watch-subs deltas.
  private rev = 0;
  private revs = new WeakMap<WatchEntry, number>();
  // Main only: subagent transcripts by spawning tool_use id (capped at SUBS_MAX), and the meta files already read.
  private subs = new Map<string, WatchTimeline>();
  private subFiles = new Map<string, string>();
  private metaSeen = new Set<string>();
  private scanAt = 0;
  private scanning: Promise<void> | null = null;

  constructor(cwd: string, id: string, subPath?: string) {
    this.cwd = cwd;
    this.id = id;
    this.sub = !!subPath;
    this.path = subPath ?? null;
    this.keep = subPath ? SUB_KEEP : KEEP;
  }

  async page(before: number | undefined, working: boolean): Promise<WatchPage> {
    await this.synced();
    const total = this.base + this.entries.length;
    const end = Math.max(0, Math.min(before ?? total, total) - this.base);
    const start = Math.max(0, end - PAGE);
    const entries = this.entries.slice(start, end);
    // The last turn has no next prompt to close it; a live one ends with the live turn-end event instead.
    if (before === undefined && this.inTurn && !working) entries.push({ k: 'turn-end', id: 'end:tail', at: this.lastAt });
    const aids = entries.filter((e) => e.k === 'agent').map((e): [string, number] => [e.id, 0]);
    const subs = aids.length ? await this.subsSince(aids) : [];
    return { entries, page: before ?? null, before: start > 0 ? this.base + start : null, ...(subs.length ? { subs } : {}) };
  }

  private synced() {
    this.syncing ??= this.sync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  // What each asked subagent added or settled since its cursor; agents with nothing new (or no transcript) are left out.
  // Read one after another, so a page with many agents never holds many read buffers at once.
  async subsSince(since: [string, number][]): Promise<WatchSub[]> {
    if (since.some(([aid]) => !this.subFiles.has(aid))) await this.scan();
    const out: WatchSub[] = [];
    for (const [aid, rev] of since) {
      const path = this.subFiles.get(aid);
      if (!path) continue;
      let t = this.subs.get(aid);
      if (!t) {
        this.subs.set(aid, (t = new WatchTimeline(this.cwd, aid, path)));
        if (this.subs.size > SUBS_MAX) this.subs.delete(this.subs.keys().next().value!);
      }
      await t.synced().catch(() => {});
      const d = t.since(rev);
      if (d.entries.length || d.rev !== rev) out.push(d);
    }
    return out;
  }

  private since(rev: number): WatchSub {
    const entries = rev ? this.entries.filter((e) => (this.revs.get(e) ?? 0) > rev) : this.entries.slice();
    return { aid: this.id, rev: this.rev, more: this.dropped, entries };
  }

  // Maps spawning tool_use ids to subagent files through the CLI's agent-*.meta.json, reading only new meta files.
  private scan() {
    if (Date.now() - this.scanAt < SCAN_MS) return Promise.resolve();
    this.scanning ??= (async () => {
      this.path ??= await transcriptPath(this.cwd, this.id);
      if (!this.path) return;
      const dir = join(this.path.replace(/\.jsonl$/, ''), 'subagents');
      const names = await readdir(dir).catch(() => [] as string[]);
      await Promise.all(names.filter((n) => n.endsWith('.meta.json') && !this.metaSeen.has(n)).map(async (n) => {
        const meta = await readFile(join(dir, n), 'utf8').then((s) => obj(JSON.parse(s)), () => null);
        // A meta file caught mid-write is read again on the next scan.
        if (!meta) return;
        this.metaSeen.add(n);
        const tid = str(meta.toolUseId);
        if (tid) this.subFiles.set(tid, join(dir, n.replace(/\.meta\.json$/, '.jsonl')));
      }));
    })().finally(() => {
      this.scanAt = Date.now();
      this.scanning = null;
    });
    return this.scanning;
  }

  private reset() {
    this.offset = this.base = this.ends = this.dropped = 0;
    this.entries = [];
    this.open.clear();
    this.inTurn = false;
    this.lastAt = null;
  }

  private touch(e: WatchEntry) {
    if (this.sub) this.revs.set(e, ++this.rev);
  }

  private async sync() {
    this.path ??= await transcriptPath(this.cwd, this.id);
    if (!this.path) return;
    const size = (await stat(this.path)).size;
    if (size < this.offset) this.reset();
    if (size === this.offset) return;
    const fh = await open(this.path, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      // A line split across chunks, kept as parts until its newline arrives.
      let rest: Buffer[] = [];
      let restLen = 0;
      let pos = this.offset;
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
        if (!bytesRead) break;
        pos += bytesRead;
        let start = 0;
        for (let nl = buf.indexOf(10, 0); nl >= 0 && nl < bytesRead; nl = buf.indexOf(10, start)) {
          const part = buf.subarray(start, nl);
          this.line((restLen ? Buffer.concat([...rest, part]) : part).toString('utf8'));
          rest = [];
          restLen = 0;
          start = nl + 1;
        }
        if (start < bytesRead) {
          rest.push(Buffer.from(buf.subarray(start, bytesRead)));
          restLen += bytesRead - start;
        }
      }
      this.offset = pos - restLen;
    } finally {
      await fh.close();
    }
  }

  private line(s: string) {
    // Cheap skip for the many bookkeeping lines (attachments, modes, titles) before paying for a parse.
    // A task-notification queued during a turn is written as an attachment, so those lines stay.
    const queued = s.includes('"queued_command"') && s.includes('<task-notification>');
    if (!queued && !s.includes('"type":"user"') && !s.includes('"type":"assistant"')) return;
    let o: Line;
    try {
      o = JSON.parse(s);
    } catch {
      return;
    }
    if ((o.isSidechain && !this.sub) || (o.type !== 'user' && o.type !== 'assistant' && o.type !== 'attachment')) return;
    const t = Date.parse(o.timestamp ?? '');
    const at = Number.isFinite(t) ? t : null;
    if (o.type === 'attachment') return void (queued && this.notify(str(obj(o.attachment).prompt), at));
    if (o.type === 'assistant') this.assistant(o, at);
    else this.user(o, at);
    this.lastAt = at ?? this.lastAt;
  }

  private push(e: WatchEntry) {
    this.entries.push(e);
    this.touch(e);
    // Trimmed in batches so the splice cost is paid rarely.
    const slack = this.sub ? 50 : 1000;
    if (this.entries.length > this.keep + slack) {
      const drop = this.entries.length - this.keep;
      for (let i = 0; i < drop; i++) if (this.entries[i].k === 'tool' || this.entries[i].k === 'agent') this.dropped++;
      this.entries.splice(0, drop);
      this.base += drop;
    }
  }

  private assistant(o: Line, at: number | null) {
    const content = o.message?.content;
    const id = o.uuid ?? `a:${this.base + this.entries.length}`;
    if (o.isApiErrorMessage) {
      const text = Array.isArray(content) ? (content as Block[]).map((b) => b.text ?? '').join(' ') : str(content);
      return this.push({ k: 'error', id, at, s: oneLine(text || 'API error', SUMMARY_MAX) });
    }
    if (!Array.isArray(content)) return;
    let texts = 0;
    for (const b of content as Block[]) {
      // <synthetic> text is a local command's output, not a reply.
      if (b.type === 'text' && b.text?.trim() && o.message?.model !== '<synthetic>') {
        const e: WatchEntry = { k: 'text', id: texts++ ? `${id}:${texts}` : id, at };
        const s = firstSentence(b.text).s;
        if (s) e.s = s;
        const g = this.sub ? '' : goalOf(b.text).goal;
        if (g) e.goal = g;
        this.push(e);
      } else if (b.type === 'tool_use' && b.id && b.name === PROGRESS_TOOL && this.sub) this.progress(b.id, obj(b.input), at);
      else if (b.type === 'tool_use' && b.id && b.name && !PLUMBING.has(b.name)) this.call(b.id, b.name, obj(b.input), at);
    }
  }

  // A subagent's progress call (or its own plan) is a step note for its lane.
  private progress(id: string, input: Obj, at: number | null) {
    const n = typeof input.total === 'number' ? input.total : 0, d = typeof input.done === 'number' ? input.done : 0;
    this.push({ k: 'note', id, at, s: oneLine(str(input.step) || str(input.task), SUMMARY_MAX), d, n });
  }

  private call(id: string, name: string, input: Obj, at: number | null) {
    const plan = planOf(name, input);
    let e: WatchEntry;
    if (plan && this.sub) {
      const cur = plan.steps.find((s) => s.status === 'doing') ?? plan.steps.findLast((s) => s.status === 'done');
      return this.push({ k: 'note', id, at, s: oneLine(cur?.text ?? plan.title, SUMMARY_MAX), d: plan.steps.filter((s) => s.status === 'done').length, n: plan.steps.length });
    }
    if (plan) e = { k: 'plan', id, at, plan };
    else if (name === 'Agent' || name === 'Task') e = { k: 'agent', id, at, s: oneLine(str(input.description) || str(input.subagent_type) || 'agent', SUMMARY_MAX), state: 'running' };
    // Always in the background: its result arrives later as a task-notification naming this call.
    else if (name === CODEX_TOOLS.agent) e = { k: 'agent', id, at, verb: 'background', s: oneLine(str(input.description) || 'Codex agent', SUMMARY_MAX), state: 'running' };
    else if (ASKS.has(name)) {
      const first = obj((input.questions as unknown[] | undefined)?.[0]);
      const q = name === 'ExitPlanMode' ? 'Plan ready for approval' : str(input.question) || str(first.question) || str(input.title) || str(first.title);
      e = { k: 'permission', id, at, verb: verbOf(name), s: oneLine(q, SUMMARY_MAX) };
    } else {
      const d = fileDelta(name, input);
      const verb = name === 'Bash' && input.run_in_background === true ? 'background' : verbOf(name);
      e = { k: 'tool', id, at, verb, s: d ? displayPath(this.cwd, d.path) : oneLine(summarizeFor(this.cwd, name, input), SUMMARY_MAX) };
      if (name === 'Bash' && str(input.description)) e.desc = oneLine(str(input.description), 100);
      if (d?.mode === 'edited') Object.assign(e, { add: d.add, rm: d.rm }, name === 'Write' ? { created: true } : {});
    }
    // Background calls answer at once and end with a task-notification; Bash already has this verb.
    if (e.k === 'agent' && input.run_in_background === true) e.verb = 'background';
    this.push(e);
    this.open.set(id, e);
    if (this.open.size > OPEN_MAX) this.open.delete(this.open.keys().next().value!);
  }

  private settle(id: string, at: number | null, err: boolean, state: AgentState) {
    const e = this.open.get(id);
    if (!e) return;
    this.open.delete(id);
    if (at !== null) e.end = at;
    if (err) e.err = true;
    if (e.k === 'agent') e.state = state;
    this.touch(e);
  }

  private notify(raw: string, at: number | null) {
    const tid = NOTE_ID.exec(raw)?.[1];
    const status = NOTE_STATUS.exec(raw)?.[1] ?? '';
    if (tid) this.settle(tid, at, status !== 'completed', status === 'completed' ? 'done' : status === 'killed' || status === 'stopped' ? 'stopped' : 'failed');
  }

  private user(o: Line, at: number | null) {
    const content = o.message?.content;
    const list = Array.isArray(content) ? (content as Block[]) : null;
    if (list) {
      for (const b of list) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const e = this.open.get(b.tool_use_id);
        // A background call's first result only says it started; so does an agent the CLI launched async.
        if ((e?.verb === 'background' || (e?.k === 'agent' && obj(o.toolUseResult).status === 'async_launched')) && !b.is_error) continue;
        if (b.is_error && e?.k === 'tool' && (e.verb === 'run' || e.verb === 'background')) e.why = failBrief(resultText((b as { content?: unknown }).content));
        this.settle(b.tool_use_id, at, !!b.is_error, b.is_error ? 'failed' : 'done');
      }
    }
    const raw = list ? list.filter((b) => b.type === 'text' && !FILE_TEXT.test(b.text ?? '')).map((b) => b.text ?? '').join('\n') : str(content);
    if (raw.includes('<task-notification>')) return this.notify(raw, at);
    // A subagent's prompts and follow-ups are its task, not actions.
    if (o.isMeta || this.sub) return;
    if (/^\s*\[Request interrupted/.test(raw)) {
      if (this.inTurn) this.push({ k: 'turn-end', id: `end:${++this.ends}`, at, err: true });
      this.inTurn = false;
      return;
    }
    const text = slashOf(raw) ?? raw;
    const files = list ? list.filter((b) => b.type === 'image' || b.type === 'document' || (b.type === 'text' && FILE_TEXT.test(b.text ?? ''))).length : 0;
    if ((!text.trim() && !files) || NOISE.test(text)) return;
    if (this.inTurn) this.push({ k: 'turn-end', id: `end:${++this.ends}`, at: this.lastAt });
    const label = o.isCompactSummary ? 'Compaction summary' : noteLabel(text) ?? (oneLine(text, SUMMARY_MAX) || `${files} file${files > 1 ? 's' : ''}`);
    this.push({ k: 'user', id: o.uuid ?? `u:${this.base + this.entries.length}`, at, s: label });
    this.inTurn = true;
  }
}
