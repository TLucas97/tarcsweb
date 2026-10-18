import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants, mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR, config } from './config.ts';
import { connect, sdkBinary } from './connect.ts';
import type { SttMessage, SttState } from './protocol.ts';
import { tuning } from './profile.ts';

const ENGINE = fileURLToPath(new URL('./stt.py', import.meta.url));
const WORK = join(CACHE_DIR, 'stt');
// A take whose stop never came (lost key-up, forgotten mic toggle) ends here.
const MAX_HOLD_MS = 5 * 60_000;
const RETRY_UNAVAILABLE_MS = 2 * 60_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

// The socket a message comes from; text and hold states go only to it.
export type SttClient = object;
type Listener = (m: SttMessage, to: SttClient | null) => void;
// One hold or mic toggle; id is the client's own number for it.
type Take = { c: SttClient; id: number };
type TakeMessage = Omit<SttMessage, 'type' | 'take'>;

const sttLanguage = () => (config.language === 'pt-BR' ? 'pt' : 'en');

let python: Promise<boolean> | null = null;
const hasPython = () => (python ??= (async () => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, 'python3'), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
})());

// Speech-to-text through Claude Code's own voice mode, driven by stt.py. One engine for the whole server.
class Stt {
  state: SttState = 'idle';
  private reason: string | null = null;
  private retryAt = 0;
  private child: ChildProcess | null = null;
  private lang = '';
  private fatal: string | null = null;
  private exited: Promise<unknown> = Promise.resolve();
  // owner: the take the engine runs, null once its client cancelled or left. run: the engine's id for that take, 0 when free.
  // pending: a take waiting for the engine to boot or to finish the take before it.
  private owner: Take | null = null;
  private pending: Take | null = null;
  private run = 0;
  private seq = 0;
  private boot = 0;
  private crashes: number[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  // One object per message, so a broadcast is serialized once.
  private emit(m: SttMessage, to: SttClient | null = null) {
    for (const fn of this.listeners) fn(m, to);
  }

  private setState(state: SttState, to: SttClient | null = null) {
    this.state = state;
    this.emit({ type: 'stt', state, ...(state === 'unavailable' && this.reason ? { error: this.reason } : {}) }, to);
  }

  private reply(c: SttClient) {
    this.emit({ type: 'stt', state: this.state, ...(this.state === 'unavailable' && this.reason ? { error: this.reason } : {}) }, c);
  }

  private tell(t: Take, m: TakeMessage) {
    this.emit({ type: 'stt', take: t.id, ...m }, t.c);
  }

  private static is(t: Take | null, c: SttClient, id: number) {
    return t?.c === c && t.id === id;
  }

  // A composer got focus or input: boot now so the first hold does not wait.
  warm(c: SttClient) {
    if (!tuning().sttPrewarm) return this.reply(c);
    this.touch();
    if (this.child && this.state === 'ready' && this.lang !== sttLanguage()) this.kill();
    const was = this.state;
    this.ensure();
    // A state change was already broadcast.
    if (this.state === was) this.reply(c);
  }

  start(c: SttClient, id: number) {
    this.touch();
    if (Stt.is(this.owner, c, id) || Stt.is(this.pending, c, id)) return;
    const t = { c, id };
    if ((this.owner && this.owner.c !== c) || (this.pending && this.pending.c !== c)) {
      return this.tell(t, { state: this.state, error: 'Voice input is in use in another window' });
    }
    // One take per client: an older one still recording stops and gets its own answer; an older queued one is dropped.
    if (this.owner && this.state === 'recording') this.write('stop', this.run);
    if (this.pending) this.tell(this.pending, { state: this.state, cancelled: true });
    this.pending = null;
    this.ensure();
    if (this.state === 'unavailable') return this.tell(t, { state: 'unavailable', error: this.reason ?? 'Voice input is unavailable' });
    this.pending = t;
    this.next();
    // Booting, or finishing the take before this one: the client shows it as waiting.
    if (this.pending === t) this.tell(t, { state: 'starting' });
  }

  stop(c: SttClient, id: number) {
    this.touch();
    if (Stt.is(this.pending, c, id)) return this.cancel(c, id);
    if (Stt.is(this.owner, c, id)) this.write('stop', this.run);
  }

  // The take's text is not wanted: a queued take ends here, a running one finishes in the background and its answer is dropped.
  cancel(c: SttClient, id: number) {
    const p = this.pending;
    if (p && Stt.is(p, c, id)) {
      this.pending = null;
      return this.tell(p, { state: this.state, cancelled: true });
    }
    const o = this.owner;
    if (!o || !Stt.is(o, c, id)) return;
    if (this.state === 'recording') this.write('stop', this.run);
    this.owner = null;
    clearTimeout(this.holdTimer ?? undefined);
    this.tell(o, { state: this.state, cancelled: true });
  }

  // The socket closed: a recording it owned stops and its text is dropped.
  drop(c: SttClient) {
    if (this.pending?.c === c) this.pending = null;
    if (this.owner?.c !== c) return;
    if (this.state === 'recording') this.write('stop', this.run);
    this.owner = null;
  }

  // Hands the engine to the queued take once it is up and free.
  private next() {
    const p = this.pending;
    if (!p || this.state !== 'ready' || this.run) return;
    this.pending = null;
    this.owner = p;
    this.run = ++this.seq;
    this.state = 'recording';
    clearTimeout(this.holdTimer ?? undefined);
    this.holdTimer = setTimeout(() => this.owner === p && this.stop(p.c, p.id), MAX_HOLD_MS);
    this.write('start', this.run);
  }

  private write(cmd: 'start' | 'stop', id: number) {
    this.child?.stdin?.write(JSON.stringify({ cmd, id }) + '\n');
  }

  private touch() {
    clearTimeout(this.idleTimer ?? undefined);
    this.idleTimer = setTimeout(() => {
      if (this.owner || this.pending || this.run) return this.touch();
      this.kill();
    }, tuning().sttIdleMs);
  }

  private async unavailableWhy(): Promise<string | null> {
    if (!(await hasPython())) return 'Voice input needs python3 on the PATH';
    const s = connect.status ?? (await connect.check());
    if (!sdkBinary()) return 'Voice input needs the Claude Code binary that ships with the SDK';
    if (!s.loggedIn || s.method !== 'claude.ai') return 'Voice input needs Claude Code signed in with a claude.ai account';
    return null;
  }

  private ensure() {
    if (this.child || this.state === 'starting') return;
    if (this.state === 'unavailable' && Date.now() < this.retryAt) return;
    this.setState('starting');
    const boot = ++this.boot;
    void this.unavailableWhy().then((why) => {
      if (boot !== this.boot) return;
      if (why) return this.unavailable(why);
      return this.spawn(boot);
    }).catch((err) => { if (boot === this.boot) this.unavailable(err instanceof Error ? err.message : String(err)); });
  }

  private unavailable(why: string) {
    this.reason = why;
    this.retryAt = Date.now() + RETRY_UNAVAILABLE_MS;
    console.log(`voice input unavailable: ${why}`);
    this.state = 'unavailable';
    this.release(why);
    this.setState('unavailable');
  }

  private async spawn(boot: number) {
    // Never two engines: a restart waits for the old one to exit.
    await this.exited;
    await mkdir(WORK, { recursive: true });
    if (boot !== this.boot) return;
    this.lang = sttLanguage();
    this.fatal = null;
    const child = spawn('python3', ['-I', ENGINE, WORK, this.lang, sdkBinary()!], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin!.on('error', () => {});
    let err = '';
    child.stderr!.on('data', (d) => (err = (err + d).slice(-2000)));
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line));
    child.on('error', (e) => (this.fatal ??= e.message));
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (err.trim()) console.error(`voice input engine stderr: ${err.trim().split('\n').slice(-3).join(' | ')}`);
      if (this.fatal) return this.unavailable(this.fatal);
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      console.error(`voice input engine exited ${code}`);
      if (this.crashes.length >= MAX_CRASHES) return this.unavailable('The voice engine keeps crashing');
      this.release('The voice engine restarted. Hold Space again');
      this.state = 'idle';
      this.ensure();
    });
  }

  private onLine(line: string) {
    let m: { ready?: boolean; id?: number; state?: string; text?: string; error?: string; fatal?: string };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.ready) {
      this.reason = null;
      this.setState('ready');
      return this.next();
    }
    if (typeof m.fatal === 'string') {
      this.fatal = m.fatal;
      return;
    }
    // A late line about an older take (or an ignored stop) changes nothing.
    if (!this.run || m.id !== this.run) return;
    if (m.state === 'recording' || m.state === 'transcribing') {
      this.state = m.state;
      if (this.owner) this.tell(this.owner, { state: m.state });
    } else if (typeof m.text === 'string' || typeof m.error === 'string') {
      const o = this.owner;
      this.owner = null;
      this.run = 0;
      clearTimeout(this.holdTimer ?? undefined);
      this.state = 'ready';
      if (o) this.tell(o, { state: 'ready', ...(typeof m.text === 'string' ? { text: m.text } : { error: m.error! }) });
      this.next();
    }
  }

  // Ends whatever take runs or waits, telling its client why.
  private release(error: string) {
    clearTimeout(this.holdTimer ?? undefined);
    const takes = [this.owner, this.pending];
    this.owner = null;
    this.pending = null;
    this.run = 0;
    for (const t of takes) if (t) this.tell(t, { state: this.state, error });
  }

  private kill() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.exited = new Promise((done) => child.once('close', done));
    this.release('Voice input stopped');
    this.setState('idle');
    // EOF on stdin makes stt.py close its claude; the signal is the fallback.
    child.stdin?.end();
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGTERM'), 3000).unref();
  }

  releaseIdle() {
    if (this.owner || this.pending || this.run) return this.touch();
    clearTimeout(this.idleTimer ?? undefined);
    this.boot++;
    if (this.child) this.kill();
    else if (this.state === 'starting') this.setState('idle');
  }

  close() {
    clearTimeout(this.idleTimer ?? undefined);
    this.child?.kill('SIGTERM');
  }
}

export const stt = new Stt();
