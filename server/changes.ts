import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ChangeCard, ChangeFile, ChangeIndexFile, DiffLine, FileDiff } from './protocol.ts';
import { displayPath } from './text.ts';
import { tuning } from './profile.ts';
import { Manifest, blobs, hashOf } from './changes/blobs.ts';
import { readText, removeFile, writeAtomic } from './changes/disk.ts';
import { fileDiff, numstat, repoRoot, status } from './changes/git.ts';

// One agent's file changes per user turn, kept as content hashes of the file before its first edit and after its last.
// The texts live in changes/blobs.ts (memory first, then disk), so only a pruned snapshot shows "No longer kept".
const FILE_MAX = 1_000_000;
const FILES_MAX = 80;
// Groups kept per session, oldest dropped (their cards keep the counts they had).
const GROUPS_MAX = 2000;
// Past this edit distance the changed middle shows as one removed block and one added block.
const DISTANCE_MAX = 2000;
const CONTEXT = 3;
const ROWS_MAX = 20_000;
const LINE_MAX = 2000;
// An "Unattributed changes" card lists at most SHELL_MAX files; a scan stats at most SCAN_MAX of them.
const SHELL_MAX = 40;
const SCAN_MAX = 400;
// File times come from a coarse kernel clock that can lag Date.now() by a tick.
const MTIME_SLACK_MS = 100;
const SEEN_MAX = 5000;
const UNDO_MAX = 30;
const INDEX_MAX = 500;
const NET_MAX = 2000;
const CONTEXT_MAX = 1000;

const REVERT = { id: 'revert', main: false };
const SHELL = { id: 'shell', main: false };
const CONFLICT = 'The file changed since this edit, so nothing was reverted';
const CONFLICT_HUNK = 'This change is no longer in the file, so nothing was reverted';

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

type Hunk = { oldStart: number; lines: string[] };
type Shown = FileDiff['hunks'][number];
type Kind = 'revert' | 'shell';
type Tracked = {
  path: string;
  abs: string;
  created: boolean;
  // Content hashes; before is null for a file that did not exist, after is null when unknown (a note says why).
  before: string | null;
  after: string | null;
  // The file no longer exists after the last edit.
  gone: boolean;
  note: string | null;
  counts: [number, number] | null;
  // Order of the first and last edit across the session, for the net change per file.
  first: number;
  last: number;
  // Seen in git status with no file tool behind it; there is no snapshot.
  shell?: true;
};
type Group = { id: string; turn: string; owner: string; main: boolean; kind?: Kind; files: Map<string, Tracked>; more: number; saved: Set<string> };
type Line = { g: string; t: string; o: string; m: boolean; k?: Kind; more: number; f: Tracked };
type Undo = { abs: string; expect: string | null; restore: string | null };
export type Owner = { id: string; main: boolean };
export type RevertResult = { error: string | null; undo: string | null };

const split = (s: string) => (s ? s.replace(/\n$/, '').split('\n') : []);
const fail = (error: string): RevertResult => ({ error, undo: null });

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

// Rows grouped into hunks with CONTEXT lines around each change; a and b are each hunk's first line numbers.
function hunksOf(rows: DiffLine[]): Shown[] {
  const hunks: Shown[] = [];
  let a = 1;
  let b = 1;
  let cur: Shown | null = null;
  let lastChange = -Infinity;
  const next = rows.map(() => Infinity);
  for (let i = rows.length - 1, n = Infinity; i >= 0; i--) {
    if (rows[i][0] !== ' ') n = i;
    next[i] = n;
  }
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i][0];
    if (k !== ' ') lastChange = i;
    if (k !== ' ' || i - lastChange <= CONTEXT || next[i] - i <= CONTEXT) {
      if (!cur) hunks.push((cur = { a, b, lines: [] }));
      cur.lines.push(rows[i]);
    } else cur = null;
    if (k !== '+') a++;
    if (k !== '-') b++;
  }
  return hunks;
}

// What the viewer gets: long lines cut, and no more than ROWS_MAX rows in all.
function shown(hunks: Shown[]) {
  const out: Shown[] = [];
  let left = ROWS_MAX;
  for (const h of hunks) {
    if (left <= 0) return { hunks: out, truncated: true };
    const lines = h.lines.slice(0, left).map(([k, t]): DiffLine => [k, t.length > LINE_MAX ? t.slice(0, LINE_MAX) + '…' : t]);
    left -= lines.length;
    out.push({ ...h, lines });
    if (lines.length < h.lines.length) return { hunks: out, truncated: true };
  }
  return { hunks: out, truncated: false };
}

// Where seq starts in lines, nearest to want; -1 when it is nowhere.
function nearest(lines: string[], seq: string[], want: number) {
  let best = -1;
  for (let i = 0; i + seq.length <= lines.length; i++) {
    if (lines[i] !== seq[0]) continue;
    let j = 1;
    while (j < seq.length && lines[i + j] === seq[j]) j++;
    if (j === seq.length && (best < 0 || Math.abs(i - want) < Math.abs(best - want))) best = i;
  }
  return best;
}

// Puts one hunk's old lines back where its new lines sit now; null when they are no longer in the file.
function undoHunk(disk: string, h: Shown) {
  const lines = split(disk);
  const now = h.lines.filter(([k]) => k !== '-').map(([, t]) => t);
  const old = h.lines.filter(([k]) => k !== '+').map(([, t]) => t);
  const want = h.b - 1;
  const fits = now.every((t, i) => lines[want + i] === t) && want <= lines.length;
  // A hunk with no new lines (a pure deletion) can only go back to its own spot.
  const at = fits ? want : now.length ? nearest(lines, now, want) : -1;
  if (at < 0) return null;
  const out = [...lines.slice(0, at), ...old, ...lines.slice(at + now.length)];
  return out.length ? out.join('\n') + (!disk || disk.endsWith('\n') ? '\n' : '') : '';
}

export class ChangeLog {
  private cwd: string;
  private turn = `start-${Date.now().toString(36)}`;
  private turnAt = Date.now();
  private seq = 0;
  // Files a file tool touched this turn, so the git scan leaves them out; capped at SEEN_MAX.
  private seen = new Set<string>();
  private lastStatus: { root: string; map: Map<string, string> } | null = null;
  private groups = new Map<string, Group>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emit: (card: ChangeCard) => void;
  private nameOf: (owner: string) => string;
  private manifest: Manifest | null;
  private loaded: Promise<void>;
  private loading = new Set<Tracked>();
  // Net counts by "first before|last after" hashes, capped at NET_MAX.
  private nets = new Map<string, [number, number]>();
  private undos = new Map<string, Undo>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(cwd: string, emit: (card: ChangeCard) => void, nameOf: (owner: string) => string, sessionId?: string) {
    this.cwd = cwd;
    this.emit = emit;
    this.nameOf = nameOf;
    this.manifest = sessionId ? new Manifest(sessionId) : null;
    this.loaded = this.manifest ? this.manifest.load<Line>((l) => `${l.g}\n${l.f?.path}`).then((lines) => this.restore(lines)) : Promise.resolve();
  }

  // Groups from earlier runs of this session: no cards, but they count in the session's net changes.
  private restore(lines: Line[]) {
    const old = new Map<string, Group>();
    for (const l of lines) {
      if (!l?.f || typeof l.g !== 'string' || this.groups.has(l.g)) continue;
      let g = old.get(l.g);
      if (!g) old.set(l.g, (g = { id: l.g, turn: l.t, owner: l.o, main: l.m, kind: l.k, files: new Map(), more: l.more ?? 0, saved: new Set() }));
      g.files.set(l.f.path, l.f);
      g.more = Math.max(g.more, l.more ?? 0);
    }
    this.groups = new Map([...old, ...this.groups]);
    this.capGroups();
  }

  startTurn(id: string) {
    this.flush();
    this.turn = id;
    this.turnAt = Date.now();
    this.seen = new Set();
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

  private next() {
    // Comparable across server runs, so restored groups order right against new ones.
    return (this.seq = Math.max(this.seq + 1, Date.now()));
  }

  private group(turn: string, owner: Owner, kind?: Kind) {
    const id = `${turn}:${owner.id}`;
    let g = this.groups.get(id);
    if (!g) {
      g = { id, turn, owner: owner.id, main: owner.main, ...(kind ? { kind } : {}), files: new Map(), more: 0, saved: new Set() };
      this.groups.set(id, g);
      this.capGroups();
    }
    return g;
  }

  private capGroups() {
    for (const id of this.groups.keys()) {
      if (this.groups.size <= GROUPS_MAX) break;
      this.groups.delete(id);
    }
  }

  private put(owner: Owner, path: string, before: string | null, after: string | null, note: string | null, kind?: Kind, gone = false) {
    const g = this.group(this.turn, owner, kind);
    const abs = isAbsolute(path) ? path : resolve(this.cwd, path);
    if (this.seen.size < SEEN_MAX) this.seen.add(abs);
    const key = displayPath(this.cwd, abs);
    let f = g.files.get(key);
    const fresh = !f;
    if (!f) {
      if (g.files.size >= FILES_MAX) {
        g.more++;
        return this.touch(g);
      }
      f = { path: key, abs, created: before === null, before: null, after: null, gone: false, note: null, counts: null, first: this.next(), last: 0 };
      g.files.set(key, f);
    }
    f.last = this.next();
    f.counts = null;
    f.gone = gone;
    if (!f.note) {
      const b = fresh ? before : null;
      if (note) f.note = note;
      else if (after === null) f.note = 'Diff not available';
      else if ((b?.length ?? 0) > FILE_MAX || after.length > FILE_MAX) f.note = 'Too large to show';
      else if (b?.includes('\u0000') || after.includes('\u0000')) f.note = 'Binary file';
    }
    if (f.note) f.before = f.after = null;
    else {
      if (fresh && before !== null) f.before = blobs.put(before);
      f.after = blobs.put(after!);
    }
    g.saved.add(key);
    this.touch(g);
  }

  private touch(g: Group) {
    this.dirty.add(g.id);
    this.timer ??= setTimeout(() => this.flush(), tuning().emitMs);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const lines: Line[] = [];
    for (const id of this.dirty) {
      const g = this.groups.get(id);
      if (!g) continue;
      this.emit(this.card(g));
      for (const key of g.saved) {
        const f = g.files.get(key);
        if (f) lines.push({ g: g.id, t: g.turn, o: g.owner, m: g.main, ...(g.kind ? { k: g.kind } : {}), more: g.more, f });
      }
      g.saved.clear();
    }
    this.dirty.clear();
    this.manifest?.append(lines);
  }

  private counts(f: Tracked, g?: Group): [number, number] {
    if (f.counts) return f.counts;
    if (f.note || f.after === null) return (f.counts = [0, 0]);
    const a = f.before === null ? '' : blobs.peek(f.before);
    const b = blobs.peek(f.after);
    if (a !== undefined && b !== undefined) return (f.counts = count(diffLines(split(a), split(b))));
    // Texts that left memory load in the background; the card goes out again once they are in.
    if (g && !this.loading.has(f)) {
      this.loading.add(f);
      void this.texts(f).then((t) => {
        this.loading.delete(f);
        if (t && !f.counts) f.counts = count(diffLines(split(t[0]), split(t[1])));
        if (t) this.touch(g);
      });
    }
    return [0, 0];
  }

  private async texts(f: Tracked): Promise<[string, string] | null> {
    if (f.note || f.after === null) return null;
    const a = f.before === null ? '' : await blobs.get(f.before);
    const b = await blobs.get(f.after);
    return a === null || b === null ? null : [a, b];
  }

  private card(g: Group): ChangeCard {
    const files: ChangeFile[] = [];
    for (const f of g.files.values()) {
      const [add, rm] = this.counts(f, g);
      // A file put back the way it was is no change.
      if (!f.shell && !f.note && f.before !== null && (f.before === f.after || (f.counts && !add && !rm))) continue;
      files.push({ path: f.path, add, rm, created: f.created, ...(f.note ? { note: f.note } : {}) });
    }
    const name = g.kind === 'revert' ? 'Reverts' : g.kind === 'shell' ? 'Unattributed changes' : g.main ? 'Main' : this.nameOf(g.owner);
    return {
      id: g.id, turn: g.turn, owner: g.owner, main: g.main, name, files, ...(g.kind ? { kind: g.kind } : {}),
      add: files.reduce((n, f) => n + f.add, 0), rm: files.reduce((n, f) => n + f.rm, 0), more: g.more,
    };
  }

  // The full diff of one file in one card, as hunks with CONTEXT lines around each change.
  async detail(id: string, path: string): Promise<FileDiff | null> {
    const f = this.groups.get(id)?.files.get(path);
    if (!f) return null;
    const base = { path: f.path, created: f.created, note: f.note, hunks: [], truncated: false };
    if (f.shell) return this.shellDetail(f, base);
    if (f.note) return { ...base, add: 0, rm: 0 };
    const t = await this.texts(f);
    if (!t) return { ...base, note: 'No longer kept', add: 0, rm: 0 };
    const old = split(t[0]);
    const rows = diffLines(old, split(t[1]));
    const [add, rm] = count(rows);
    return { ...base, add, rm, ...shown(hunksOf(rows)), lines: old.length, revertable: true };
  }

  // A file no tool wrote: its diff against HEAD as git has it, or the whole file when git does not track it.
  private async shellDetail(f: Tracked, base: Omit<FileDiff, 'add' | 'rm'>): Promise<FileDiff> {
    const none = { ...base, note: 'Diff not available', add: 0, rm: 0 };
    const root = await repoRoot(this.cwd);
    if (!root) return none;
    const out = await fileDiff(root, relative(root, f.abs));
    let hunks: Shown[];
    if (out) {
      hunks = diffHunks(out).map((h) => ({ a: h.oldStart, b: h.newStart, lines: h.lines.filter((l) => l[0] !== '\\').map((l): DiffLine => [l[0] as DiffLine[0], l.slice(1)]) }));
    } else {
      const text = await readText(f.abs);
      if (typeof text !== 'string' || text.length > FILE_MAX) return none;
      hunks = [{ a: 1, b: 1, lines: split(text).map((l): DiffLine => ['+', l]) }];
    }
    const [add, rm] = count(hunks.flatMap((h) => h.lines));
    return { ...base, add, rm, ...shown(hunks) };
  }

  // Unchanged lines of a file's old side, [from, from + n), for the viewer's collapsed gaps.
  async context(id: string, path: string, from: number, n: number): Promise<string[] | null> {
    const f = this.groups.get(id)?.files.get(path);
    if (!f || f.shell || f.note || f.before === null) return null;
    const text = await blobs.get(f.before);
    if (text === null) return null;
    return split(text).slice(from - 1, from - 1 + Math.min(n, CONTEXT_MAX)).map((t) => (t.length > LINE_MAX ? t.slice(0, LINE_MAX) + '…' : t));
  }

  // Reverts and undos run one at a time, so two clicks never interleave on one file.
  private serial<T>(fn: () => Promise<T>) {
    const p = this.writes.then(fn);
    this.writes = p.catch(() => {});
    return p;
  }

  // Puts one file of a card (or one hunk, by its index in detail()) back as it was, if the file still holds that edit.
  revert(id: string, path: string, hunk: number | null) {
    return this.serial(async (): Promise<RevertResult> => {
      const f = this.groups.get(id)?.files.get(path);
      if (!f) return fail('This change is no longer tracked');
      if (f.shell || f.note) return fail('This change has no saved copy to go back to');
      const t = await this.texts(f);
      if (!t) return fail('The saved copy of this file is no longer kept');
      const [old, now] = t;
      const disk = await readText(f.abs);
      if (disk === undefined) return fail('The file can no longer be read as text');
      const hunks = hunksOf(diffLines(split(old), split(now)));
      const same = f.gone ? disk === null : disk === now || (disk === null && now === '');
      let target: string | null;
      if (hunk === null && same) target = f.before === null ? null : old;
      else {
        // A file with one change can still go back when other lines moved since.
        const h = hunks[hunk ?? (hunks.length === 1 ? 0 : -1)];
        if (!h) return fail(hunk === null ? CONFLICT : 'This change is no longer in the diff');
        if (disk === null) return fail(CONFLICT);
        const back = undoHunk(disk, h);
        if (back === null) return fail(hunk === null ? CONFLICT : CONFLICT_HUNK);
        target = back === '' && f.before === null && hunks.length === 1 ? null : back;
      }
      if (target === disk) return fail('The file already looks like that');
      return this.write(f.abs, disk, target);
    });
  }

  // Takes back a revert by its token, if the file is still the way the revert left it.
  undo(token: string) {
    return this.serial(async (): Promise<RevertResult> => {
      const u = this.undos.get(token);
      if (!u) return fail('This revert can no longer be undone');
      const disk = await readText(u.abs);
      if (disk === undefined) return fail('The file can no longer be read as text');
      if (u.expect === null ? disk !== null : disk === null || hashOf(disk) !== u.expect) return fail('The file changed after the revert, so nothing was undone');
      const restore = u.restore === null ? null : await blobs.get(u.restore);
      if (u.restore !== null && restore === null) return fail('The saved copy of this file is no longer kept');
      const r = await this.write(u.abs, disk, restore, false);
      if (!r.error) this.undos.delete(token);
      return r;
    });
  }

  // Writes the file (null deletes it) and records it in this turn's Reverts card.
  private async write(abs: string, disk: string | null, target: string | null, undoable = true): Promise<RevertResult> {
    try {
      if (target === null) await removeFile(abs);
      else await writeAtomic(abs, target);
    } catch (err) {
      return fail(`Could not write the file: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.put(REVERT, abs, disk, target ?? '', null, 'revert', target === null);
    this.flush();
    if (!undoable) return { error: null, undo: null };
    const token = randomUUID();
    this.undos.set(token, { abs, expect: target === null ? null : blobs.put(target), restore: disk === null ? null : blobs.put(disk) });
    if (this.undos.size > UNDO_MAX) this.undos.delete(this.undos.keys().next().value!);
    return { error: null, undo: token };
  }

  // After each turn in a git repo: files the working tree changed with no file tool behind them (a shell command, an editor).
  turnEnded() {
    const turn = this.turn;
    const since = this.turnAt;
    const seen = this.seen;
    void this.scan(turn, since, seen).catch((err) => console.warn('[changes] git scan failed', err));
  }

  private async scan(turn: string, since: number, seen: Set<string>) {
    const root = await repoRoot(this.cwd);
    const now = root && (await status(root));
    if (!root || !now) return;
    const base = this.lastStatus?.root === root ? this.lastStatus.map : null;
    this.lastStatus = { root, map: now };
    const picks: [string, string][] = [];
    let more = 0;
    let looked = 0;
    for (const [abs, code] of now) {
      if (seen.has(abs)) continue;
      // A deletion has no mtime: it counts when the last scan still had the file.
      if (code.includes('D')) {
        if (!base || base.get(abs)?.includes('D')) continue;
      } else {
        if (++looked > SCAN_MAX) break;
        const st = await stat(abs).catch(() => null);
        if (!st || st.mtimeMs < since - MTIME_SLACK_MS) continue;
      }
      if (picks.length < SHELL_MAX) picks.push([abs, code]);
      else more++;
    }
    const had = this.groups.has(`${turn}:${SHELL.id}`);
    if (!picks.length && !had) return;
    const stats = await numstat(root, picks.filter(([, c]) => c !== '??').map(([abs]) => relative(root, abs)));
    const g = this.group(turn, SHELL, 'shell');
    g.files.clear();
    g.more = more;
    for (const [abs, code] of picks) {
      let counts = stats.get(abs) ?? [0, 0];
      if (code === '??') {
        const text = await readText(abs);
        counts = [typeof text === 'string' ? split(text).length : 0, 0];
      }
      const key = displayPath(this.cwd, abs);
      const at = this.next();
      g.files.set(key, { path: key, abs, created: code === '??' || code[0] === 'A', before: null, after: null, gone: code.includes('D'), note: null, counts, first: at, last: at, shell: true });
      g.saved.add(key);
    }
    this.touch(g);
  }

  // Net lines added and removed per file over the whole session: first snapshot against last, not a sum of turns.
  async index(): Promise<ChangeIndexFile[]> {
    await this.loaded;
    type Entry = { first?: Tracked; last?: Tracked; sum: [number, number]; shell?: Tracked };
    const by = new Map<string, Entry>();
    for (const g of this.groups.values()) {
      for (const f of g.files.values()) {
        let e = by.get(f.path);
        if (!e) {
          if (by.size >= INDEX_MAX) continue;
          by.set(f.path, (e = { sum: [0, 0] }));
        }
        if (f.shell) {
          if (!e.shell || f.last > e.shell.last) e.shell = f;
          continue;
        }
        if (!e.first || f.first < e.first.first) e.first = f;
        if (!e.last || f.last > e.last.last) e.last = f;
        const [a, r] = this.counts(f);
        e.sum[0] += a;
        e.sum[1] += r;
      }
    }
    const out: ChangeIndexFile[] = [];
    for (const [path, e] of by) {
      if (!e.first || !e.last) {
        const s = e.shell!;
        out.push({ path, add: s.counts?.[0] ?? 0, rm: s.counts?.[1] ?? 0, ...(s.created ? { created: true } : {}), shell: true });
        continue;
      }
      const net = await this.net(e.first, e.last);
      if (net && !net[0] && !net[1]) continue;
      const [add, rm] = net ?? e.sum;
      out.push({ path, add, rm, ...(e.first.created ? { created: true } : {}) });
    }
    return out;
  }

  private async net(first: Tracked, last: Tracked): Promise<[number, number] | null> {
    if (first.note || last.note || last.after === null) return null;
    const key = `${first.before}|${last.after}`;
    const hit = this.nets.get(key);
    if (hit) return hit;
    const a = first.before === null ? '' : await blobs.get(first.before);
    const b = await blobs.get(last.after);
    if (a === null || b === null) return null;
    const c = count(diffLines(split(a), split(b)));
    if (this.nets.size >= NET_MAX) this.nets.delete(this.nets.keys().next().value!);
    this.nets.set(key, c);
    return c;
  }
}
