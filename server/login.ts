import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { authBinary, connect, firstLine } from './connect.ts';
import type { LoginState } from './protocol.ts';

const TIMEOUT_MS = 10 * 60_000;
// The CLI prompts without a newline, so the prompt itself ends a line.
const PROMPT = /Paste code here if prompted\s*>\s*/;
const HAPPY = /^(Opening browser|If the browser didn't open)/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const NO_CLI = 'The claude CLI is not installed';

// One `claude auth login` at a time, driven from the UI. The URL and the code are never logged.
class Login {
  state: LoginState = { state: 'idle', url: null, error: null };
  private child: ChildProcessWithoutNullStreams | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private buf = '';
  private last: string | null = null;
  private listeners = new Set<(s: LoginState) => void>();

  subscribe(fn: (s: LoginState) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(patch: Partial<LoginState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  // A call, so TS does not keep a narrowing across awaits.
  private phase() {
    return this.state.state;
  }

  async start() {
    if (this.phase() !== 'idle') return;
    this.set({ state: 'starting', url: null, error: null });
    const bin = await authBinary();
    // Cancelled while the binary was being looked up.
    if (this.phase() !== 'starting') return;
    if (!bin) return this.set({ state: 'idle', error: NO_CLI });
    const child = spawn(bin, ['auth', 'login'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buf = '';
    this.last = null;
    child.stdout.setEncoding('utf8').on('data', (s: string) => this.read(s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => this.read(s));
    // EPIPE when the CLI exits before a code is written.
    child.stdin.on('error', () => {});
    child.on('error', (e) => this.finish(child, null, firstLine(e.message)));
    child.on('close', (code) => this.finish(child, code, null));
    this.timer = setTimeout(() => this.stop(child, 'Sign-in timed out. Try again.'), TIMEOUT_MS);
  }

  private read(chunk: string) {
    this.buf += chunk.replace(ANSI, '').replace(/\r/g, '');
    const prompted = PROMPT.test(this.buf);
    if (prompted) this.buf = this.buf.replace(PROMPT, '\n');
    const lines = this.buf.split('\n');
    this.buf = lines.pop()!.slice(-2000);
    for (const raw of lines) this.line(raw.trim());
    if (prompted && this.state.state === 'starting') this.set({ state: 'waiting' });
  }

  private line(l: string) {
    if (!l) return;
    const url = this.state.url ? null : l.match(/https:\/\/\S+/)?.[0];
    if (url) return this.set({ state: this.state.state === 'starting' ? 'waiting' : this.state.state, url });
    if (HAPPY.test(l)) return;
    this.last = l.slice(0, 200);
    // A rejected code: the CLI keeps waiting for another one.
    if (this.state.state === 'verifying') this.set({ state: 'waiting', error: this.last });
  }

  code(code: string) {
    const c = this.child;
    if (!c || this.state.state !== 'waiting' || !c.stdin.writable) return;
    this.set({ state: 'verifying', error: null });
    c.stdin.write(code.replace(/\s+/g, '') + '\n');
  }

  private finish(child: ChildProcessWithoutNullStreams, code: number | null, error: string | null) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.timer);
    if (code === 0) {
      this.set({ state: 'idle', url: null, error: null });
      void connect.recheck();
      return;
    }
    this.set({ state: 'idle', url: null, error: error ?? this.last ?? `Sign-in failed (exit ${code})` });
  }

  private stop(child: ChildProcessWithoutNullStreams | null, error: string | null) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.timer);
    child?.kill();
    this.set({ state: 'idle', url: null, error });
  }

  cancel() {
    if (this.state.state === 'idle' || this.state.state === 'signing-out') return;
    this.stop(this.child, null);
  }

  async logout() {
    if (this.state.state !== 'idle') return;
    this.set({ state: 'signing-out', url: null, error: null });
    const bin = await authBinary();
    const error = bin
      ? await new Promise<string | null>((done) =>
          execFile(bin, ['auth', 'logout'], { timeout: 20_000 }, (e, _out, err) => done(e ? firstLine(String(err) || e.message) : null)),
        )
      : NO_CLI;
    await connect.recheck();
    this.set({ state: 'idle', error });
  }

  close() {
    this.child?.kill();
    this.child = null;
    clearTimeout(this.timer);
  }
}

export const login = new Login();
