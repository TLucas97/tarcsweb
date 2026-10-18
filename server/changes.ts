import type { ChangeCard, ChangeFile, DiffLine, FileDiff } from './protocol.ts';
import { displayPath } from './text.ts';
import { tuning } from './profile.ts';

// One agent's file changes per user turn, kept as the file before its first edit and after its last.
const FILE_MAX = 1_000_000;
const BUDGET = 24_000_000;
const FILES_MAX = 80;
// Past this edit distance the changed middle shows as one removed block and one added block.
const DISTANCE_MAX = 2000;
const CONTEXT = 3;
const ROWS_MAX = 20_000;
const LINE_MAX = 2000;

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

type Hunk = { oldStart: number; lines: string[] };
type Tracked = { path: string; before: string | null; after: string | null; note: string | null; counts: [number, number] | null };
type Group = { id: string; turn: string; owner: string; main: boolean; files: Map<string, Tracked>; more: number; size: number };
export type Owner = { id: string; main: boolean };

const split = (s: string) => (s ? s.replace(/\n$/, '').split('\n') : []);

// Applies the CLI's structuredPatch to the original text; null when a hunk does not fit.
function applyPatch(original: string, hunks: Hunk[]): string | null {
  const src = original.split('\n');
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    const start = h.oldStart - 1;
    if (start < at || start > src.length) return null;
    out.push(...src.slice(at, start));
    at = start;
    for (const l of h.lines) {
      const k = l[0];
      const t = l.slice(1);
      if (k === '\\') continue;
      if (k === '+') out.push(t);
      else if (src[at] !== t) return null;
      else {
        if (k === ' ') out.push(t);
        at++;
      }
    }
  }
  out.push(...src.slice(at));
  return out.join('\n');
}

// The hunks of a unified diff; file headers and anything before the first @@ are skipped.
export function diffHunks(diff: string): (Hunk & { newStart: number })[] {
  const out: (Hunk & { newStart: number })[] = [];
  let cur: (Hunk & { newStart: number }) | null = null;
  for (const l of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) out.push((cur = { oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] }));
    else if (cur && /^[ +\-\\]/.test(l)) cur.lines.push(l);
    else if (cur && l === '') cur.lines.push(' ');
  }
  // split leaves one empty string after the final newline.
  if (cur?.lines.at(-1) === ' ' && diff.endsWith('\n')) cur.lines.pop();
  return out;
}

// The text before a patch, from the text after it; null when a hunk does not fit.
export function unpatch(after: string, diff: string): string | null {
  const hunks = diffHunks(diff);
  if (!hunks.length) return null;
  const flip = (l: string) => (l[0] === '+' ? `-${l.slice(1)}` : l[0] === '-' ? `+${l.slice(1)}` : l);
  return applyPatch(after, hunks.map((h) => ({ oldStart: Math.max(1, h.newStart), lines: h.lines.map(flip) })));
}

// Before and after text of one successful file tool call, from its tool_response.
function versions(tool: string, input: Obj, res: Obj): { path: string; before: string | null; after: string | null; unknown: boolean } | null {
  if (res.staged === true) return null;
  if (tool === 'NotebookEdit') {
    const path = str(res.notebook_path) ?? str(input.notebook_path);
    const before = str(res.original_file);
    const after = str(res.updated_file);
    return path && after !== null ? { path, before, after, unknown: before === null } : null;
  }
  const path = str(res.filePath) ?? str(input.file_path);
  if (!path) return null;
  const original = res.originalFile === null ? null : str(res.originalFile);
  if (tool === 'Write') {
    const after = str(res.content);
    if (after === null) return null;
    return { path, before: original, after, unknown: original === null && res.type === 'update' };
  }
  if (original === null) return { path, before: null, after: null, unknown: true };
  const hunks = Array.isArray(res.structuredPatch) ? (res.structuredPatch as Hunk[]) : [];
  let after = hunks.length ? applyPatch(original, hunks) : null;
  if (after === null) {
    const oldS = str(res.oldString) ?? '';
    const newS = str(res.newString) ?? '';
    after = !oldS ? original : res.replaceAll ? original.split(oldS).join(newS) : original.replace(oldS, () => newS);
  }
  return { path, before: original, after, unknown: false };
}

// Myers' O(ND) line diff; ' ' kept, '-' only in a, '+' only in b.
export function diffLines(a: string[], b: string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const A = a.slice(start, a.length - end);
  const B = b.slice(start, b.length - end);
  const head: DiffLine[] = a.slice(0, start).map((t) => [' ', t]);
  const tail: DiffLine[] = a.slice(a.length - end).map((t) => [' ', t]);
  return [...head, ...middle(A, B), ...tail];
}

function middle(A: string[], B: string[]): DiffLine[] {
  const N = A.length;
  const M = B.length;
  const plain = (): DiffLine[] => [...A.map((t) => ['-', t] as DiffLine), ...B.map((t) => ['+', t] as DiffLine)];
  if (!N || !M) return plain();
  const max = Math.min(N + M, DISTANCE_MAX);
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= N && y >= M) found = d;
    }
    trace.push(V.slice(off - d, off + d + 1));
  }
  if (found < 0) return plain();
  const out: DiffLine[] = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) {
      x--;
      y--;
      out.push([' ', A[x]]);
    }
    if (down) out.push(['+', B[--y]]);
    else out.push(['-', A[--x]]);
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push([' ', A[x]]);
  }
  return out.reverse();
}

const count = (rows: DiffLine[]): [number, number] => {
  let add = 0;
  let rm = 0;
  for (const [k] of rows) k === '+' ? add++ : k === '-' && rm++;
  return [add, rm];
};

export class ChangeLog {
  private cwd: string;
  private turn = 'start';
  private groups = new Map<string, Group>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emit: (card: ChangeCard) => void;
  private nameOf: (owner: string) => string;

  constructor(cwd: string, emit: (card: ChangeCard) => void, nameOf: (owner: string) => string) {
    this.cwd = cwd;
    this.emit = emit;
    this.nameOf = nameOf;
  }

  startTurn(id: string) {
    this.flush();
    this.turn = id;
  }

  // Called from the PostToolUse hook, which fires after the write for the main thread and subagents alike.
  record(owner: Owner, tool: string, input: unknown, response: unknown) {
    const v = versions(tool, obj(input), obj(response));
    if (v) this.put(owner, v.path, v.before, v.after, v.unknown ? 'Too large to show' : null);
  }

  // For agents that report a patch instead of a tool response (Codex); the caller works out both texts.
  recordTexts(owner: Owner, path: string, before: string | null, after: string | null, note: string | null = null) {
    this.put(owner, path, before, after, note);
  }

  private put(owner: Owner, path: string, before: string | null, after: string | null, note: string | null) {
    const v = { path, before, after };
    const id = `${this.turn}:${owner.id}`;
    let g = this.groups.get(id);
    if (!g) {
      g = { id, turn: this.turn, owner: owner.id, main: owner.main, files: new Map(), more: 0, size: 0 };
      this.groups.set(id, g);
    }
    const key = displayPath(this.cwd, v.path);
    let f = g.files.get(key);
    if (!f) {
      if (g.files.size >= FILES_MAX) {
        g.more++;
        return this.touch(g);
      }
      f = { path: key, before: v.before, after: v.after, note: null, counts: null };
      g.files.set(key, f);
    } else f.after = v.after;
    f.counts = null;
    if (note) f.note = note;
    else if (f.note === null && ((f.before?.length ?? 0) > FILE_MAX || (f.after?.length ?? 0) > FILE_MAX)) f.note = 'Too large to show';
    else if (f.note === null && (f.before?.includes('\u0000') || f.after?.includes('\u0000'))) f.note = 'Binary file';
    if (f.note) {
      f.before = '';
      f.after = '';
    }
    g.size = [...g.files.values()].reduce((n, x) => n + (x.before?.length ?? 0) + (x.after?.length ?? 0), 0);
    this.trim();
    this.touch(g);
  }

  private touch(g: Group) {
    this.dirty.add(g.id);
    this.timer ??= setTimeout(() => this.flush(), tuning().emitMs);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.dirty) {
      const g = this.groups.get(id);
      if (g) this.emit(this.card(g));
    }
    this.dirty.clear();
  }

  // Oldest turns lose their texts first; their cards stay with the counts they had.
  private trim() {
    let total = [...this.groups.values()].reduce((n, g) => n + g.size, 0);
    for (const g of this.groups.values()) {
      if (total <= BUDGET || g.turn === this.turn) break;
      for (const f of g.files.values()) {
        this.counts(f);
        if (!f.note) f.note = 'No longer kept';
        f.before = '';
        f.after = '';
      }
      total -= g.size;
      g.size = 0;
    }
  }

  private rows(f: Tracked) {
    return diffLines(split(f.before ?? ''), split(f.after ?? ''));
  }

  private counts(f: Tracked): [number, number] {
    if (!f.counts) f.counts = f.note ? [0, 0] : count(this.rows(f));
    return f.counts;
  }

  private card(g: Group): ChangeCard {
    const files: ChangeFile[] = [];
    for (const f of g.files.values()) {
      const [add, rm] = this.counts(f);
      // A file put back the way it was is no change.
      if (!f.note && !add && !rm && f.before !== null && f.after !== null) continue;
      files.push({ path: f.path, add, rm, created: f.before === null, ...(f.note ? { note: f.note } : {}) });
    }
    return {
      id: g.id, turn: g.turn, owner: g.owner, main: g.main, name: g.main ? 'Main' : this.nameOf(g.owner), files,
      add: files.reduce((n, f) => n + f.add, 0), rm: files.reduce((n, f) => n + f.rm, 0), more: g.more,
    };
  }

  // The full diff of one file in one card, as hunks with CONTEXT lines around each change.
  detail(id: string, path: string): FileDiff | null {
    const f = this.groups.get(id)?.files.get(path);
    if (!f) return null;
    const base = { path: f.path, created: f.before === null, note: f.note, hunks: [], truncated: false };
    if (f.note) return { ...base, add: 0, rm: 0 };
    const rows = this.rows(f);
    const [add, rm] = count(rows);
    const hunks: FileDiff['hunks'] = [];
    let a = 1;
    let b = 1;
    let shown = 0;
    let truncated = false;
    let cur: FileDiff['hunks'][number] | null = null;
    let lastChange = -Infinity;
    const next = rows.map(() => Infinity);
    for (let i = rows.length - 1, n = Infinity; i >= 0; i--) {
      if (rows[i][0] !== ' ') n = i;
      next[i] = n;
    }
    for (let i = 0; i < rows.length; i++) {
      const [k, t] = rows[i];
      if (k !== ' ') lastChange = i;
      const near = k !== ' ' || i - lastChange <= CONTEXT || next[i] - i <= CONTEXT;
      if (near && !truncated) {
        if (shown >= ROWS_MAX) truncated = true;
        else {
          if (!cur) {
            cur = { a, b, lines: [] };
            hunks.push(cur);
          }
          cur.lines.push([k, t.length > LINE_MAX ? t.slice(0, LINE_MAX) + '…' : t]);
          shown++;
        }
      } else cur = null;
      if (k !== '+') a++;
      if (k !== '-') b++;
    }
    return { ...base, add, rm, hunks, truncated };
  }
}
