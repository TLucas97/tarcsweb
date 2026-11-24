import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, glob, lstat, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { InnerCall, SearchPathFilter, ToolOutput } from './types.ts';

const OUTPUT_CAP = 30_000;

// The shell for $: the user's bash or zsh, else bash, like the CLI's Bash tool. On Windows it is Git Bash, found the
// CLI's way; never bash.exe on PATH (that can be WSL's, which sees other paths). SHELL there is a POSIX path spawn cannot run.
export const SHELL = (() => {
  if (process.platform === 'win32') {
    const fromGit = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir && existsSync(join(dir, 'git.exe')))
      .map((dir) => resolve(dir, '..', 'bin', 'bash.exe'));
    const tries = [process.env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', ...fromGit];
    return tries.find((path) => path && existsSync(path)) ?? null;
  }
  const own = process.env.SHELL;
  return own && /\/(bash|zsh)$/.test(own) ? own : '/bin/bash';
})();
const READ_CAP = 5 * 1024 * 1024;
const GLOB_CAP = 1000;

type ReadTarget = { path: string; dev: bigint; ino: bigint };
const approvedReads = new WeakMap<Record<string, unknown>, ReadTarget | null>();

export async function readTarget(path: string): Promise<ReadTarget | null> {
  if (/^[\\/]{2}[^\\/]/.test(path)) return null;
  try {
    const actual = await realpath(path);
    const info = await stat(actual, { bigint: true });
    return info.isFile() ? { path: actual, dev: info.dev, ino: info.ino } : null;
  } catch {
    return null;
  }
}

export function approveRead(input: Record<string, unknown>, target: ReadTarget | null) {
  approvedReads.set(input, target);
}

export function resolveToolPath(cwd: string, path: string, expandHome = true): string {
  if (expandHome && (path === '~' || path.startsWith('~/'))) return resolve(homedir(), path.slice(2));
  if (/^[\\/]{2}[^\\/]/.test(path)) return path;
  if (process.platform === 'win32') path = path.replace(/^\/([a-z])(?:\/|$)/i, '$1:/');
  return resolve(cwd, path);
}

export function normalize(call: InnerCall, cwd: string): InnerCall {
  const input: Record<string, unknown> = {};
  function strings(...keys: string[]) {
    for (const key of keys) {
      const value = Object.hasOwn(call.input, key) && call.input[key];
      if (typeof value === 'string') input[key] = value;
    }
  }
  function number(key: string, min: number, max: number) {
    const value = Object.hasOwn(call.input, key) && call.input[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      input[key] = Math.min(max, Math.max(min, Math.trunc(value)));
    }
  }
  switch (call.tool) {
    case 'Bash':
      strings('command', 'description');
      number('timeout', 1, 600_000);
      break;
    case 'Read':
      strings('file_path');
      number('offset', 1, Number.MAX_SAFE_INTEGER);
      number('limit', 1, 2000);
      break;
    case 'Glob':
      strings('pattern', 'path');
      break;
    case 'Grep':
      strings('pattern', 'path', 'glob', 'type');
      if (Object.hasOwn(call.input, 'output_mode') && ['content', 'files_with_matches', 'count'].includes(call.input.output_mode as string)) {
        input.output_mode = call.input.output_mode;
      }
      for (const key of ['-i', '-n', 'multiline']) {
        if (Object.hasOwn(call.input, key) && typeof call.input[key] === 'boolean') input[key] = call.input[key];
      }
      for (const key of ['-A', '-B', '-C']) number(key, 0, 2000);
      number('head_limit', 0, OUTPUT_CAP);
      break;
  }
  for (const key of ['file_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value) input[key] = resolveToolPath(cwd, value);
  }
  if (call.tool === 'Read' && approvedReads.has(call.input)) approveRead(input, approvedReads.get(call.input)!);
  return { ...call, input };
}

type ProcessOptions = {
  cwd: string;
  signal: AbortSignal;
  timeout?: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  cap?: number;
  preserveHead?: boolean;
  onStdout?: (chunk: string) => Promise<void>;
};

class Capture {
  cap: number;
  preserveHead: boolean;
  size = 0;
  head = '';
  tail = '';

  constructor(cap: number, preserveHead = false) {
    this.cap = cap;
    this.preserveHead = preserveHead;
  }

  append(chunk: string) {
    this.size += chunk.length;
    if (this.preserveHead) {
      this.head += chunk.slice(0, this.cap - this.head.length);
      return;
    }
    const room = Math.floor(this.cap / 2) - this.head.length;
    this.head += chunk.slice(0, room);
    this.tail = (this.tail + chunk.slice(room)).slice(-Math.ceil(this.cap / 2));
  }

  result() {
    if (this.preserveHead || this.size <= this.cap) return this.head + this.tail;
    let tailSize = this.cap - this.head.length;
    let marker = '';
    for (;;) {
      marker = '\n[… ' + (this.size - this.head.length - tailSize) + ' chars cut …]\n';
      const next = Math.max(0, this.cap - this.head.length - marker.length);
      if (next === tailSize) break;
      tailSize = next;
    }
    return this.head + marker + (tailSize ? this.tail.slice(-tailSize) : '');
  }
}

export async function runProcess(file: string, args: string[], options: ProcessOptions) {
  const { cwd, signal, timeout, stdin, env, cap = OUTPUT_CAP, onStdout } = options;
  const stdout = new Capture(cap, options.preserveHead);
  const stderr = new Capture(cap);
  let interrupted = signal.aborted;
  let timedOut = false;
  let error: string | undefined;
  let signaled = false;
  let exitCode = -1;

  if (!interrupted) {
    try {
      exitCode = await new Promise<number>((done) => {
        const windows = process.platform === 'win32';
        const child = spawn(file, args, {
          cwd, env, detached: !windows, windowsHide: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        let killTimer: NodeJS.Timeout | undefined;
        let closed: number | undefined;
        let drain = Promise.resolve();
        const killGroup = (killSignal: NodeJS.Signals | 0) => {
          if (child.pid === undefined) return false;
          // Windows has no process groups; taskkill /T ends the tree, and its liveness probe reports none.
          if (windows) {
            if (killSignal === 0) return false;
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
              .once('error', () => { child.kill(); })
              .once('exit', (code) => { if (code !== 0) child.kill(); });
            return true;
          }
          try {
            process.kill(-child.pid, killSignal);
            return true;
          } catch {
            return false;
          }
        };
        const kill = (killSignal: NodeJS.Signals) => {
          if (!killGroup(killSignal)) child.kill(killSignal);
        };
        function finish(code: number) {
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal.removeEventListener('abort', stop);
          void drain.then(() => done(code));
        }
        function stop() {
          if (interrupted) return;
          interrupted = true;
          kill('SIGTERM');
          killTimer = setTimeout(() => {
            killTimer = undefined;
            kill('SIGKILL');
            if (closed !== undefined) finish(closed);
          }, 2000);
        }
        const timer = timeout === undefined ? undefined : setTimeout(() => {
          timedOut = true;
          stop();
        }, timeout);
        signal.addEventListener('abort', stop, { once: true });
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
          if (onStdout) {
            child.stdout?.pause();
            // Chained so a chunk Node emits while paused never runs beside the previous one.
            drain = drain.then(() => onStdout(chunk)).catch((cause) => {
              error = cause instanceof Error ? cause.message : String(cause);
              stop();
            }).finally(() => { child.stdout?.resume(); });
          } else stdout.append(chunk);
        });
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => stderr.append(chunk));
        child.stdin?.on('error', () => {});
        child.stdin?.end(stdin);
        child.on('error', (cause) => { error = cause.message; });
        child.on('close', (code, childSignal) => {
          signaled = childSignal !== null;
          closed = code ?? -1;
          clearTimeout(timer);
          if (killTimer === undefined || !killGroup(0)) finish(closed);
        });
        if (signal.aborted) stop();
      });
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause);
    }
  }
  return {
    stdout: stdout.result(), stderr: stderr.result(), exitCode, error, interrupted, timedOut, signaled,
    truncated: stdout.size > cap || stderr.size > cap,
  };
}

let rg: Promise<string | undefined> | undefined;
function findRg() {
  rg ??= (async () => {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!isAbsolute(dir)) continue;
      const path = resolve(dir, process.platform === 'win32' ? 'rg.exe' : 'rg');
      try {
        await access(path, constants.X_OK);
        if ((await stat(path)).isFile()) return path;
      } catch {
        continue;
      }
    }
    return undefined;
  })();
  return rg;
}

function inside(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function displayPath(cwd: string, path: string) {
  return inside(cwd, path) ? relative(cwd, path) || '.' : path;
}

export function failure(tool: InnerCall['tool'], message: string): ToolOutput {
  switch (tool) {
    case 'Bash': return { isError: true, data: { stdout: '', stderr: message, exitCode: -1, interrupted: false } };
    case 'Read': return { isError: true, data: { text: message, totalLines: 0, truncated: false } };
    case 'Glob': return { isError: true, data: { files: [message], truncated: false } };
    case 'Grep': return { isError: true, data: { output: message, truncated: false } };
  }
}

async function readText(path: string, target: ReadTarget | null, offset: number, limit: number, signal: AbortSignal): Promise<ToolOutput> {
  const changed = 'The file changed after approval. Request a new Read.';
  if (!target) return failure('Read', 'Expected an approved regular text file.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.dev !== target.dev || info.ino !== target.ino) return failure('Read', changed);
    const openedPath = await realpath('/proc/self/fd/' + handle.fd).catch(() => undefined);
    if (openedPath !== undefined ? openedPath !== target.path : await realpath(path).catch(() => undefined) !== target.path) {
      return failure('Read', changed);
    }
    const buffer = Buffer.alloc(Math.min(Number(info.size) || 8192, READ_CAP));
    let size = 0;
    do {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    } while (size < buffer.length);
    if (buffer.subarray(0, Math.min(size, 8192)).includes(0)) {
      return failure('Read', 'Binary files are unsupported here. Use the regular Read tool instead.');
    }
    const text = buffer.toString('utf8', 0, size);
    const lines = text ? text.split(/\r?\n/) : [];
    if (lines.at(-1) === '') lines.pop();
    const window = lines.slice(offset - 1, offset - 1 + limit);
    const cut = window.some((line) => line.length > 2000);
    return {
      isError: false,
      data: {
        text: window.map((line) => line.slice(0, 2000)).join('\n'),
        totalLines: lines.length,
        truncated: info.size > size || offset - 1 + limit < lines.length || cut,
        cut,
        ...(info.size > size ? { capped: Number(info.size) } : {}),
      },
    };
  } finally {
    await handle.close();
  }
}

async function globFiles(pattern: string, path: string, cwd: string, signal: AbortSignal, pathAllowed?: SearchPathFilter): Promise<ToolOutput> {
  if (isAbsolute(pattern) || pattern.startsWith('!') || pattern.split('/').includes('..')) {
    return failure('Glob', 'Use a relative glob pattern within path.');
  }
  if (!(await stat(path)).isDirectory()) return failure('Glob', 'Expected a directory for path.');
  const executable = await findRg();
  const recent: { path: string; mtime: number }[] = [];
  const pending: string[] = [];
  let count = 0;
  async function addBatch(batch: string[]) {
    const candidates = await Promise.all(batch.map(async (file) => {
      const full = resolve(path, file);
      if (!inside(path, full)) return undefined;
      const info = await lstat(full).catch(() => undefined);
      if (!info?.isFile()) return undefined;
      if (pathAllowed && !await pathAllowed(full)) return undefined;
      return { path: displayPath(cwd, full), mtime: info.mtimeMs };
    }));
    for (const file of candidates) {
      if (!file) continue;
      count++;
      recent.push(file);
    }
    recent.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    recent.length = Math.min(recent.length, GLOB_CAP);
  }
  if (executable) {
    let rest = '';
    const cleanPattern = pattern.replace(/^\.\//, '');
    // Positive rg globs override ignore files, so filter after listing.
    const result = await runProcess(executable, ['--no-config', '--no-follow', '--no-require-git', '--files', '--null', '--', '.'], {
      cwd: path, signal, async onStdout(chunk) {
        const files = (rest + chunk).split('\0');
        rest = files.pop() ?? '';
        const matched = files.filter((file) => matchesGlob(
          cleanPattern.includes('/') ? file.replace(/^\.\//, '') : basename(file), cleanPattern,
        ));
        for (let index = 0; index < matched.length; index += 64) {
          signal.throwIfAborted();
          await addBatch(matched.slice(index, index + 64));
        }
      },
    });
    if (result.interrupted) return failure('Glob', 'Glob interrupted.');
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return failure('Glob', (!pathAllowed && (result.error || result.stderr.trim())) || 'Glob failed.');
    }
  } else {
    for await (const file of glob(pattern.includes('/') ? pattern : '**/' + pattern, { cwd: path })) {
      signal.throwIfAborted();
      pending.push(file);
      if (pending.length === 64) await addBatch(pending.splice(0));
    }
    await addBatch(pending);
  }
  return { isError: false, data: { files: recent.map((file) => file.path), truncated: count > GLOB_CAP } };
}

type RgValue = { text: string } | { bytes: string };
type RgRecord =
  | { type: 'begin' | 'end'; data: { path: RgValue } }
  | { type: 'match' | 'context'; data: { path: RgValue; lines: RgValue; line_number: number; submatches?: unknown[] } }
  | { type: 'summary' };

async function grepFiles(input: Record<string, unknown>, cwd: string, signal: AbortSignal, pathAllowed?: SearchPathFilter): Promise<ToolOutput> {
  if (typeof input.pattern !== 'string') return failure('Grep', 'A grep pattern is required.');
  const executable = await findRg();
  if (!executable) return failure('Grep', 'ripgrep is unavailable. Use $`grep …` instead.');
  const path = (input.path as string | undefined) || cwd;
  const mode = input.output_mode ?? 'files_with_matches';
  const args = ['--no-config', '--no-follow', '--no-require-git', '--color', 'never'];
  if (input['-i']) args.push('-i');
  if (input.multiline) args.push('-U', '--multiline-dotall');
  if (typeof input.glob === 'string') {
    // Commas inside a brace expansion belong to ripgrep's glob.
    for (const pattern of input.glob.split(/,(?![^{}]*\})/)) {
      if (pattern.trim()) args.push('--glob', pattern.trim());
    }
  }
  if (typeof input.type === 'string') args.push('--type', input.type);
  if (pathAllowed) args.push('--json');
  // Files mode needs one match per file, as --files-with-matches stopped at the first.
  if (pathAllowed && mode === 'files_with_matches') args.push('-m', '1');
  if (mode === 'content') {
    if (!pathAllowed) {
      args.push('--with-filename');
      if (input['-n'] !== false) args.push('-n');
    }
    for (const key of ['-C', '-B', '-A']) {
      if (typeof input[key] === 'number') args.push(key, String(input[key]));
    }
  } else if (!pathAllowed) {
    if (mode === 'count') args.push('--count', '--with-filename');
    else args.push('--files-with-matches');
  }
  const filtered = new Capture(OUTPUT_CAP, true);
  let rest = '';
  let allowedPath: string | undefined;
  let matches = 0;
  let lastLine = 0;
  const context = Boolean(input['-A'] || input['-B'] || input['-C']);
  const result = await runProcess(executable, [...args, '-e', input.pattern, '--', displayPath(cwd, path)], {
    cwd, signal, preserveHead: true,
    // Structured records keep every match and context line tied to its originating file.
    onStdout: pathAllowed && (async (chunk) => {
      const rows = (rest + chunk).split('\n');
      rest = rows.pop() ?? '';
      for (const row of rows) {
        signal.throwIfAborted();
        const record = JSON.parse(row) as RgRecord;
        if (record.type === 'summary' || !('text' in record.data.path)) continue;
        const file = record.data.path.text;
        if (record.type === 'begin') {
          allowedPath = await pathAllowed(resolve(cwd, file)) ? file : undefined;
          matches = 0;
          lastLine = -1;
        } else if (file === allowedPath) {
          if (record.type === 'end') {
            if (mode !== 'content' && matches) filtered.append(mode === 'count' ? file + ':' + matches + '\n' : file + '\n');
            allowedPath = undefined;
          } else if (record.type === 'match' || record.type === 'context') {
            // rg --count counts lines, but in multiline mode one record can hold several counted matches.
            if (record.type === 'match') matches += input.multiline ? Math.max(1, record.data.submatches?.length ?? 1) : 1;
            if (mode !== 'content') continue;
            const { line_number, lines } = record.data;
            const text = 'text' in lines ? lines.text : Buffer.from(lines.bytes, 'base64').toString('utf8');
            const separator = record.type === 'match' ? ':' : '-';
            if (context && filtered.size && line_number !== lastLine + 1) filtered.append('--\n');
            const parts = text.replace(/\n$/, '').split('\n');
            for (const [index, line] of parts.entries()) {
              filtered.append(file + separator + (input['-n'] === false ? '' : (line_number + index) + separator) + line + '\n');
            }
            lastLine = line_number + parts.length - 1;
          }
        }
      }
    }),
  });
  if (result.interrupted) return failure('Grep', 'Grep interrupted.');
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return failure('Grep', (!pathAllowed && (result.error || result.stderr.trim())) || 'Grep failed.');
  }
  let output = pathAllowed ? filtered.result() : result.stdout;
  let truncated = pathAllowed ? filtered.size > filtered.cap : result.truncated;
  const head = input.head_limit as number | undefined;
  if (head && output) {
    const lines = output.replace(/\n$/, '').split('\n');
    truncated ||= lines.length > head;
    output = lines.slice(0, head).join('\n');
  } else {
    output = output.replace(/\n$/, '');
  }
  return { isError: false, data: { output, truncated } };
}

export async function execute(call: InnerCall, cwd: string, signal: AbortSignal, pathAllowed?: SearchPathFilter): Promise<ToolOutput> {
  const { input, tool } = normalize(call, cwd);
  try {
    if (signal.aborted && tool !== 'Bash') return failure(tool, 'Tool call interrupted.');
    if ((tool === 'Glob' || tool === 'Grep') && typeof input.path === 'string' && input.path &&
        relative(input.path, await realpath(input.path)) !== '') {
      return failure(tool, 'Search paths cannot follow symbolic links.');
    }
    switch (tool) {
      case 'Bash': {
        if (typeof input.command !== 'string' || !input.command.trim()) return failure(tool, 'A Bash command is required.');
        const timeout = (input.timeout as number | undefined) ?? 120_000;
        if (!SHELL) return failure(tool, 'No POSIX shell found. Install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe.');
        const result = await runProcess(SHELL, ['-c', input.command], { cwd, signal, timeout });
        const message = result.error ?? (result.timedOut ? 'Command timed out.' : result.interrupted ? 'Command interrupted.' : '');
        return {
          isError: result.exitCode !== 0 || result.interrupted,
          data: {
            stdout: result.stdout, stderr: result.stderr || message,
            exitCode: result.exitCode, interrupted: result.interrupted, truncated: result.truncated,
          },
        };
      }
      case 'Read': {
        if (typeof input.file_path !== 'string' || !input.file_path) return failure(tool, 'A file path is required.');
        const target = approvedReads.has(input) ? approvedReads.get(input)! : await readTarget(input.file_path);
        return await readText(input.file_path, target, (input.offset as number | undefined) ?? 1, (input.limit as number | undefined) ?? 2000, signal);
      }
      case 'Glob':
        if (typeof input.pattern !== 'string' || !input.pattern) return failure(tool, 'A glob pattern is required.');
        return await globFiles(input.pattern, (input.path as string | undefined) || cwd, cwd, signal, pathAllowed);
      case 'Grep':
        return await grepFiles(input, cwd, signal, pathAllowed);
    }
  } catch (cause) {
    return failure(tool, signal.aborted ? 'Tool call interrupted.' : String(cause instanceof Error ? cause.message : cause));
  }
}

export function summary(call: InnerCall): string {
  const { input, tool } = call;
  let label: string;
  if (tool === 'Bash') label = String(input.command ?? '');
  else if (tool === 'Read') {
    const offset = Number(input.offset ?? 1);
    const range = input.limit ? ':' + offset + '-' + (offset + Number(input.limit) - 1) : input.offset ? ':' + offset : '';
    label = String(input.file_path ?? '') + range;
  } else {
    label = String(input.pattern ?? '') + (input.path ? ' in ' + String(input.path) : '');
  }
  return label.replace(/\s+/g, ' ').trim() || tool;
}
