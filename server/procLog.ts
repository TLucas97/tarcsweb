// Finds where a background command writes its output and tails every place, so the log pane is never stuck on stale text.
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { LogSource, LogSourceInfo, ServerMessage } from './protocol.ts';

// Bytes read from the end of a log file per read.
export const LOG_TAIL = 64 * 1024;
// Files tailed per command; extra redirects are ignored.
const MAX_TARGETS = 4;
// In auto mode the pane leaves a source only after it has been quiet this long, so two busy sources do not flicker.
const SWITCH_QUIET_MS = 4000;

export async function tailFile(path: string) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, LOG_TAIL);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return { text: buf.toString('utf8'), truncated: size > len };
  } finally {
    await fh.close();
  }
}

type Word = { kind: 'word'; text: string; dyn: boolean };
type Tok = Word | { kind: 'op'; text: string };

// A small shell lexer: quotes, escapes, $HOME and ~, operators and redirections. dyn marks a word with other expansions.
function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let word = '';
  let dyn = false;
  let inWord = false;
  let i = 0;
  let wantDelim = false;
  const heredocs: string[] = [];
  const flush = () => {
    if (inWord) {
      if (wantDelim) heredocs.push(word);
      else out.push({ kind: 'word', text: word, dyn });
      wantDelim = false;
    }
    word = '';
    dyn = false;
    inWord = false;
  };
  const dollar = () => {
    const m = /^\$(?:HOME\b|\{HOME\})/.exec(src.slice(i, i + 7));
    if (m) {
      word += homedir();
      i += m[0].length;
    } else {
      word += '$';
      dyn = true;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      if (src[i + 1] !== '\n') {
        word += src[i + 1] ?? '';
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const e = end < 0 ? src.length : end;
      word += src.slice(i + 1, e);
      inWord = true;
      i = e + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          word += src[i + 1];
          i += 2;
        } else if (src[i] === '$') dollar();
        else word += src[i++];
      }
      i++;
    } else if (c === '$') {
      inWord = true;
      dollar();
    } else if (c === '~' && !inWord && /^~(?:\/|$|\s)/.test(src.slice(i, i + 2))) {
      word += homedir();
      inWord = true;
      i++;
    } else if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === ' ' || c === '\t') {
      flush();
      i++;
    } else if (c === '\n') {
      flush();
      out.push({ kind: 'op', text: ';' });
      i++;
      // Heredoc bodies are data, not commands.
      for (const delim of heredocs.splice(0)) {
        while (i < src.length) {
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if (line.trim() === delim) break;
        }
      }
    } else if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      const m = /^(?:&>>?|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(src.slice(i, i + 3))!;
      let fd = '';
      if (inWord && /^\d+$/.test(word)) {
        fd = word;
        word = '';
        inWord = false;
      } else flush();
      out.push({ kind: 'op', text: fd + m[0] });
      if (m[0] === '<<' || m[0] === '<<-') wantDelim = true;
      i += m[0].length;
    } else {
      const m = /^(?:&&|\|\||\|&|;;|[;|&()])/.exec(src.slice(i, i + 2));
      if (m) {
        flush();
        out.push({ kind: 'op', text: m[0] });
        i += m[0].length;
      } else {
        word += c;
        inWord = true;
        i++;
      }
    }
  }
  flush();
  return out;
}

// Prefixes that run the next word as the command.
const WRAPPERS = new Set(['sudo', 'exec', 'command', 'nohup', 'time', 'env', 'nice', 'stdbuf']);

// Files a command writes its output to (`> f`, `>> f`, `&> f`, `2> f`, `tee [-a] f`), anywhere in it, resolved against
// the directory each part runs in after earlier `cd`s. Skips /dev/*, fd duplications and paths with variables.
export function outputTargets(command: string, cwd: string): string[] {
  const toks = lex(command);
  const out: string[] = [];
  const dirs: string[] = [];
  let dir = cwd;
  let words: Word[] = [];
  const add = (w: Word) => {
    if (w.dyn || !w.text) return;
    const p = resolve(dir, w.text);
    if (!p.startsWith('/dev/') && !out.includes(p)) out.push(p);
  };
  const end = () => {
    let k = 0;
    while (k < words.length && (WRAPPERS.has(words[k]!.text) || /^\w+=/.test(words[k]!.text) || (k > 0 && words[k]!.text.startsWith('-')))) k++;
    const [head, ...args] = words.slice(k);
    if (head?.text === 'cd') {
      const to = args.find((a) => !a.text.startsWith('-') || a.text === '-');
      if (!to) dir = homedir();
      else if (!to.dyn && to.text !== '-') dir = resolve(dir, to.text);
    } else if (head?.text === 'tee') for (const a of args) if (!a.text.startsWith('-')) add(a);
    words = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === 'word') {
      words.push(t);
      continue;
    }
    if (/[<>]/.test(t.text)) {
      const next = toks[i + 1];
      if (next?.kind !== 'word') continue;
      i++;
      const input = t.text.includes('<') && !t.text.includes('<>');
      const dup = t.text.endsWith('&') && /^(?:\d+-?|-)$/.test(next.text);
      if (!input && !dup) add(next);
      continue;
    }
    end();
    if (t.text === '(') dirs.push(dir);
    else if (t.text === ')') dir = dirs.pop() ?? dir;
  }
  end();
  return out.slice(0, MAX_TARGETS);
}

type TaskOutput = { output: string; total_bytes: number; truncated: boolean };
// What a watch needs from the session to find and read one task's output.
export type LogProbe = { command: string; cwd: string; ended: boolean; summary: string | null; outputFile: string | null; live: () => Promise<TaskOutput | null> };
type ProcLogMsg = Extract<ServerMessage, { type: 'proc-log' }>;
// changedAt: when it last grew (file mtime, or seen growing while watched), null when unknown.
type Src = LogSourceInfo & { changedAt: number | null; sig: string; read: () => Promise<{ text: string; truncated: boolean }> };

async function fileSrc(path: string, key: string, kind: LogSource, label: string): Promise<Src | null> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    return { key, kind, label, path, bytes: st.size, changedAt: st.mtimeMs, sig: `${path}:${st.size}:${st.mtimeMs}`, read: () => tailFile(path) };
  } catch {
    return null;
  }
}

// One client's view of one task: which sources it has, which one it shows, and what it already sent.
export class LogWatch {
  readonly sessionId: string;
  readonly taskId: string;
  readonly seenAt = Date.now();
  // A source the user picked; null follows the newest output.
  private pick: string | null = null;
  private shown: string | null = null;
  private sentSig = '';
  private liveBytes = -1;
  private liveAt: number | null = null;
  private targets: string[] | null = null;

  constructor(sessionId: string, taskId: string) {
    this.sessionId = sessionId;
    this.taskId = taskId;
  }

  // The client cleared its text on a pick, so the next read always resends.
  choose(key: string) {
    this.pick = key;
    this.sentSig = '';
  }

  // The caller confirms a delivered text with sent(), so a dropped stale read never suppresses the next one.
  sent(sig: string) {
    this.sentSig = sig;
  }

  async tick(p: LogProbe): Promise<{ msg: ProcLogMsg; sig: string | null }> {
    this.targets ??= outputTargets(p.command, p.cwd);
    const live = await p.live().catch(() => null);
    if (live && live.total_bytes !== this.liveBytes) {
      // Growth is only known once watched; earlier output has no time.
      if (this.liveBytes >= 0) this.liveAt = Date.now();
      this.liveBytes = live.total_bytes;
    }
    const srcs: Src[] = [];
    if (live && (live.total_bytes > 0 || !p.ended)) {
      srcs.push({ key: 'live', kind: 'live', label: 'Output', bytes: live.total_bytes, changedAt: this.liveAt, sig: `live:${live.total_bytes}`, read: async () => ({ text: live.output, truncated: live.truncated }) });
    } else if (p.ended && p.outputFile) {
      const f = await fileSrc(p.outputFile, 'file', 'file', 'Output');
      if (f?.bytes) srcs.push(f);
    }
    for (const f of await Promise.all(this.targets.map((t) => fileSrc(t, t, 'redirect', basename(t))))) if (f) srcs.push(f);
    if (!srcs.some((s) => s.bytes > 0) && (p.ended || !live)) {
      const text = p.summary ?? '';
      srcs.splice(0, srcs.length, { key: 'summary', kind: 'summary', label: 'Summary', bytes: text.length, changedAt: null, sig: `summary:${text}`, read: async () => ({ text, truncated: false }) });
    }

    const at = (s: Src) => s.changedAt ?? -1;
    const newest = srcs.filter((s) => s.bytes > 0).sort((a, b) => at(b) - at(a))[0];
    let cur = (this.pick && srcs.find((s) => s.key === this.pick)) || srcs.find((s) => s.key === this.shown);
    if (!this.pick || cur?.key !== this.pick) {
      if (!cur?.bytes) cur = newest ?? srcs[0]!;
      else if (newest && at(newest) > at(cur) && Date.now() - at(cur) > SWITCH_QUIET_MS) cur = newest;
    }
    this.shown = cur.key;

    let body: { text: string; truncated: boolean } | null = null;
    if (cur.sig !== this.sentSig) {
      try {
        body = await cur.read();
        if (body.text.includes('\0')) body = { text: '(binary data, not shown)', truncated: false };
      } catch {}
    }
    // Relative times, so a client with another clock still shows the right age.
    const known = Math.max(0, ...srcs.map((s) => s.changedAt ?? 0));
    const untimed = srcs.some((s) => s.kind !== 'summary' && s.bytes > 0 && s.changedAt === null);
    const since = untimed ? Math.max(known, this.seenAt) : known;
    const now = Date.now();
    const msg: ProcLogMsg = {
      type: 'proc-log', sessionId: this.sessionId, taskId: this.taskId, ended: p.ended,
      sources: srcs.map(({ key, kind, label, path, bytes }) => ({ key, kind, label, bytes, ...(path ? { path } : {}) })),
      shown: cur.key, source: cur.kind, ...(cur.path ? { path: cur.path } : {}), ...(body ?? {}),
      quiet: since ? { ms: Math.max(0, Math.round(now - since)), exact: since === known } : null,
    };
    return { msg, sig: body ? cur.sig : null };
  }
}
