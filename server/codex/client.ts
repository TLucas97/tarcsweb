import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { onPath } from '../connect.ts';
import type { Method, RequestId, Requests, RpcError } from './types.ts';

// The app-server protocol drifts per release; this is the one the hand-written types match.
export const TESTED_VERSION = '0.155';
const VERSION = /^codex-cli (\d+\.\d+\.\d+)$/;
const IDLE_MS = 10 * 60_000;
// A process booted only to list sessions goes away sooner (~330 MB while it runs).
const BRIEF_IDLE_MS = 60_000;
const REQUEST_MS = 60_000;
const STDERR_LINES = 20;

export type CodexBinary = { path: string | null; version: string | null; versionOk: boolean };
export type ServerRequest = { id: RequestId; method: string; params: unknown };
export type RequestHandler = (req: ServerRequest) => Promise<unknown>;

export class CodexError extends Error {
  code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
  }
}
// Not having codex is a normal state; callers show it instead of an error.
export class CodexMissing extends CodexError {
  constructor() {
    super('The codex CLI is not installed');
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string };
type Incoming = { id?: RequestId | null; method?: unknown; params?: unknown; result?: unknown; error?: RpcError };

const version = (bin: string) =>
  new Promise<string | null>((done) =>
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, out) => done(err ? null : String(out).trim().match(VERSION)?.[1] ?? null)),
  );

// One `codex app-server` per tarcsweb server, started on first request and stopped after a long idle with nothing held.
export class CodexClient {
  binary: CodexBinary | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<ChildProcessWithoutNullStreams> | null = null;
  private seq = 0;
  private pending = new Map<RequestId, Pending>();
  private notes = new Set<(method: string, params: unknown) => void>();
  private exits = new Set<(reason: string) => void>();
  private handler: RequestHandler | null = null;
  private holds = 0;
  private brief = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private stderr: string[] = [];
  private warned: string | null = null;

  get running() {
    return this.proc !== null;
  }

  async checkBinary(force = false): Promise<CodexBinary> {
    if (this.binary && !force) return this.binary;
    const path = process.env.CW_CODEX_BIN || (await onPath('codex'));
    const v = path ? await version(path) : null;
    this.binary = { path, version: v, versionOk: !!v && v.startsWith(`${TESTED_VERSION}.`) };
    if (path && !this.binary.versionOk && this.warned !== v) {
      this.warned = v;
      console.warn(`[codex] codex-cli ${v ?? '(unknown version)'} is untested; tarcsweb expects ${TESTED_VERSION}.x and the protocol may differ`);
    }
    return this.binary;
  }

  onNotification(fn: (method: string, params: unknown) => void) {
    this.notes.add(fn);
    return () => void this.notes.delete(fn);
  }

  // Called with a reason whenever the process goes away, planned or not; pending requests are already rejected.
  onExit(fn: (reason: string) => void) {
    this.exits.add(fn);
    return () => void this.exits.delete(fn);
  }

  setRequestHandler(fn: RequestHandler | null) {
    this.handler = fn;
  }

  // Keeps the process alive (a live thread, a sign-in waiting for its callback); call the returned function to let go.
  hold() {
    this.holds++;
    this.brief = false;
    clearTimeout(this.idle);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holds--;
      this.touch();
    };
  }

  async request<M extends Method>(method: M, params: Requests[M][0], timeoutMs = REQUEST_MS): Promise<Requests[M][1]> {
    this.brief = false;
    const child = await this.start();
    return this.call(child, method, params, timeoutMs) as Promise<Requests[M][1]>;
  }

  // A request that keeps the short idle when it is what booted the process.
  async peek<M extends Method>(method: M, params: Requests[M][0]): Promise<Requests[M][1]> {
    if (!this.ready) this.brief = true;
    const child = await this.start();
    return this.call(child, method, params, REQUEST_MS) as Promise<Requests[M][1]>;
  }

  close() {
    const child = this.proc;
    if (!child) return;
    child.stdin.end();
    child.kill('SIGTERM');
  }

  private start() {
    this.ready ??= this.boot().catch((e: unknown) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async boot() {
    const bin = await this.checkBinary();
    if (!bin.path) throw new CodexMissing();
    // Home as cwd, so the server's own folder never adds project config; threads pass their cwd.
    const child = spawn(bin.path, ['app-server'], { cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = child;
    this.stderr = [];
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => {
      buf += s;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.read(child, line);
      }
    });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      const lines = (err + s).split('\n');
      err = lines.pop()!.slice(-2000);
      for (const l of lines) if (l.trim()) this.stderr.push(l.slice(0, 300));
      if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES);
    });
    child.on('error', (e) => this.exited(child, e.message));
    child.on('exit', (code, signal) => this.exited(child, signal ? `killed by ${signal}` : `exit ${code}`));
    await new Promise<void>((ok, fail) => {
      child.once('spawn', ok);
      child.once('error', fail);
    });
    try {
      await this.call(child, 'initialize', {
        clientInfo: { name: 'tarcsweb', title: 'tarcsweb', version: '1.0.0' },
        capabilities: { experimentalApi: true, optOutNotificationMethods: ['turn/diff/updated'] },
      }, 30_000);
    } catch (e) {
      child.kill('SIGTERM');
      throw e;
    }
    this.write(child, { method: 'initialized' });
    this.touch();
    return child;
  }

  private exited(child: ChildProcessWithoutNullStreams, how: string) {
    if (this.proc !== child) return;
    this.proc = null;
    this.ready = null;
    this.brief = false;
    clearTimeout(this.idle);
    const reason = `Codex app-server stopped (${how})`;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CodexError(reason));
      this.pending.delete(id);
    }
    if (how !== 'exit 0' && how !== 'killed by SIGTERM') console.warn(`[codex] ${reason}${this.stderr.length ? `\n${this.stderr.join('\n')}` : ''}`);
    for (const fn of this.exits) {
      try {
        fn(reason);
      } catch (e) {
        console.error('[codex] exit listener failed', e);
      }
    }
  }

  private call(child: ChildProcessWithoutNullStreams, method: string, params: unknown, timeoutMs: number) {
    const id = ++this.seq;
    clearTimeout(this.idle);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError(`Codex did not answer ${method}`));
        this.touch();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write(child, params === undefined ? { id, method } : { id, method, params });
    });
  }

  private write(child: ChildProcessWithoutNullStreams, msg: object) {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private read(child: ChildProcessWithoutNullStreams, line: string) {
    let msg: Incoming;
    try {
      msg = JSON.parse(line) as Incoming;
    } catch {
      return console.warn(`[codex] unreadable line: ${line.slice(0, 200)}`);
    }
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) return void this.serve(child, { id: msg.id, method: msg.method, params: msg.params });
      for (const fn of this.notes) {
        try {
          fn(msg.method, msg.params);
        } catch (e) {
          console.error(`[codex] ${msg.method} listener failed`, e);
        }
      }
      return;
    }
    const p = msg.id !== undefined && msg.id !== null ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new CodexError(msg.error.message || `${p.method} failed`, msg.error.code));
    else p.resolve(msg.result);
    this.touch();
  }

  private async serve(child: ChildProcessWithoutNullStreams, req: ServerRequest) {
    let reply: object;
    try {
      if (!this.handler) throw new CodexError(`tarcsweb does not handle ${req.method}`, -32601);
      reply = { id: req.id, result: (await this.handler(req)) ?? {} };
    } catch (e) {
      const code = e instanceof CodexError && e.code !== null ? e.code : -32603;
      reply = { id: req.id, error: { code, message: e instanceof Error ? e.message : String(e) } };
    }
    // A restarted process never asked this.
    if (this.proc === child) this.write(child, reply);
  }

  private touch() {
    clearTimeout(this.idle);
    if (!this.proc || this.holds > 0 || this.pending.size > 0) return;
    this.idle = setTimeout(() => {
      if (this.holds === 0 && this.pending.size === 0) this.close();
    }, this.brief ? BRIEF_IDLE_MS : IDLE_MS);
    this.idle.unref();
  }
}

export const codex = new CodexClient();
