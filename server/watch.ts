import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_PREFIX, SUMMARY_PREFIX, type AgentState, type WatchEntry, type WatchPage } from './protocol.ts';
import { APP_TOOLS, CODEX_TOOLS, PLUMBING, planOf, summarizeFor, verbOf } from './tools.ts';
import { fileDelta } from './agents.ts';
import { displayPath, oneLine } from './text.ts';
import { FILE_TEXT, NOISE, slashOf, type Block } from './history.ts';

// Entries kept per session (oldest dropped first), entries per watch-load reply, and calls awaiting a result.
const KEEP = 20_000;
const PAGE = 2_000;
const OPEN_MAX = 500;
const CHUNK = 1 << 20;
const SUMMARY_MAX = 120;
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

const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

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
export class WatchTimeline {
  readonly id: string;
  private cwd: string;
  private path: string | null = null;
  private offset = 0;
  // entries[i] has cursor base + i; capped at KEEP.
  private entries: WatchEntry[] = [];
  private base = 0;
  private open = new Map<string, WatchEntry>();
  // A prompt opened a turn that no later prompt or interrupt closed yet.
  private inTurn = false;
  private lastAt: number | null = null;
  private ends = 0;
  private syncing: Promise<void> | null = null;

  constructor(cwd: string, id: string) {
    this.cwd = cwd;
    this.id = id;
  }

  async page(before: number | undefined, working: boolean): Promise<WatchPage> {
    this.syncing ??= this.sync().finally(() => (this.syncing = null));
    await this.syncing;
    const total = this.base + this.entries.length;
    const end = Math.max(0, Math.min(before ?? total, total) - this.base);
    const start = Math.max(0, end - PAGE);
    const entries = this.entries.slice(start, end);
    // The last turn has no next prompt to close it; a live one ends with the live turn-end event instead.
    if (before === undefined && this.inTurn && !working) entries.push({ k: 'turn-end', id: 'end:tail', at: this.lastAt });
    return { entries, page: before ?? null, before: start > 0 ? this.base + start : null };
  }

  private reset() {
    this.offset = this.base = this.ends = 0;
    this.entries = [];
    this.open.clear();
    this.inTurn = false;
    this.lastAt = null;
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
    if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant' && o.type !== 'attachment')) return;
    const t = Date.parse(o.timestamp ?? '');
    const at = Number.isFinite(t) ? t : null;
    if (o.type === 'attachment') return void (queued && this.notify(str(obj(o.attachment).prompt), at));
    if (o.type === 'assistant') this.assistant(o, at);
    else this.user(o, at);
    this.lastAt = at ?? this.lastAt;
  }

  private push(e: WatchEntry) {
    this.entries.push(e);
    // Trimmed in batches so the splice cost is paid rarely.
    if (this.entries.length > KEEP + 1000) {
      const drop = this.entries.length - KEEP;
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
    for (const b of content as Block[]) {
      // <synthetic> text is a local command's output, not a reply.
      if (b.type === 'text' && b.text?.trim() && o.message?.model !== '<synthetic>') this.push({ k: 'text', id, at });
      else if (b.type === 'tool_use' && b.id && b.name && !PLUMBING.has(b.name)) this.call(b.id, b.name, obj(b.input), at);
    }
  }

  private call(id: string, name: string, input: Obj, at: number | null) {
    const plan = planOf(name, input);
    let e: WatchEntry;
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
        this.settle(b.tool_use_id, at, !!b.is_error, b.is_error ? 'failed' : 'done');
      }
    }
    const raw = list ? list.filter((b) => b.type === 'text' && !FILE_TEXT.test(b.text ?? '')).map((b) => b.text ?? '').join('\n') : str(content);
    if (raw.includes('<task-notification>')) return this.notify(raw, at);
    if (o.isMeta) return;
    if (/^\s*\[Request interrupted/.test(raw)) {
      if (this.inTurn) this.push({ k: 'turn-end', id: `end:${++this.ends}`, at, err: true });
      this.inTurn = false;
      return;
    }
    const text = slashOf(raw) ?? raw;
    const files = list ? list.filter((b) => b.type === 'image' || b.type === 'document' || (b.type === 'text' && FILE_TEXT.test(b.text ?? ''))).length : 0;
    if ((!text.trim() && !files) || NOISE.test(text)) return;
    if (this.inTurn) this.push({ k: 'turn-end', id: `end:${++this.ends}`, at: this.lastAt });
    const label = o.isCompactSummary || text.startsWith(SUMMARY_PREFIX) ? 'Compaction summary' : text.startsWith(HANDOFF_PREFIX) ? 'Context handoff' : oneLine(text, SUMMARY_MAX) || `${files} file${files > 1 ? 's' : ''}`;
    this.push({ k: 'user', id: o.uuid ?? `u:${this.base + this.entries.length}`, at, s: label });
    this.inTurn = true;
  }
}
