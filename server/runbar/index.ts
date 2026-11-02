// The run bar's server side: one set of processes per folder, shared by every session and window in it.
// Runs are detached and write to a log file, so they outlive a server restart and are adopted again at boot.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, open, readdir, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { openTab } from '../appWindow.ts';
import { CACHE_DIR } from '../config.ts';
import { isWslHost } from '../machine.ts';
import { tuning } from '../profile.ts';
import { tailFile } from '../procLog.ts';
import { ask } from '../titles.ts';
import { OWNED_ENV } from '../terminal.ts';
import { DESTRUCTIVE, detect, finderContext } from './detect.ts';
import { holderOf, listening, memoryMb, parentOf, portsOf, startTicks, startTicksSync, tree } from './procs.ts';
import type { RunClientMessage, RunCommand, RunEdit, RunFolder, RunHolder, RunKind, RunServerMessage, RunState, RunSuggestion } from './types.ts';

// The live app (24816, or 24817 in Dev mode) keeps the shared dir; another port without its own CW_CACHE gets one of
// its own, so a test instance never adopts, overwrites or stops the live runs.
const PORT = Number(process.env.CW_PORT) || 24817;
const DIR = join(CACHE_DIR, 'runbar', process.env.CW_CACHE || PORT === 24816 || PORT === 24817 ? '' : `port-${PORT}`);
const FILE = join(DIR, 'state.json');
const LOGS = join(DIR, 'logs');
// Logs no saved run points to are deleted at boot once this old.
const LOG_KEEP_MS = 86_400_000;
// A log past this is emptied; the running process keeps appending to the same file.
const LOG_MAX = 8 << 20;
// Lines streamed to an open inline log.
const LOG_LINES = 40;
// A service with no known port counts as up after this long without failing.
const SETTLE_MS = 15_000;
const KILL_MS = 6000;
const DETECT_TTL = 10_000;
// Bash runs of one command in a day before it is suggested as a shortcut.
const REPEATS = 3;
// Caps per folder; folders past FOLDERS_MAX without live runs are forgotten, oldest first.
const SHORTCUTS_MAX = 50;
const SUGGESTIONS_MAX = 10;
const DISMISSED_MAX = 200;
const REPEATS_MAX = 200;
const EDITS_MAX = 200;
const FOLDERS_MAX = 100;
const FIND_TIMEOUT_MS = 90_000;
const STEP = /::cweb step (\d+)\/(\d+)::/g;
const EXIT = /::cweb exit (\d+)::/g;
const READY = /\b(ready in|listening|Local:|started server|server running|compiled successfully)\b/i;
// The port follows a colon or "port", so the 127 of 127.0.0.1:3000 or an errno is never read as one.
const IN_USE = /(?:EADDRINUSE|address already in use)[^\n]{0,60}?(?::|\bport\s+)(\d{2,5})\b|port (\d{2,5}) is (?:already )?in use/i;
const ERROR_LINE = /error|failed|cannot|not found|exception|ERR!|✗|panicked/i;

type Saved = { id: string; pid: number; ticks: string; startedAt: number; log: string; cmd: RunCommand; step?: [number, number] };
type Store = {
  edits: Record<string, RunEdit>;
  shortcuts: RunCommand[];
  suggestions: RunSuggestion[];
  dismissed: string[];
  repeats: Record<string, { day: string; n: number }>;
  runs: Saved[];
  // Groups a Stop sent SIGTERM and had not yet killed.
  drain: { pid: number; ticks: string }[];
  seen: number;
};
type Run = {
  folder: string;
  cmd: RunCommand;
  state: RunState;
  pid: number;
  ticks: string;
  log: string;
  child: ChildProcess | null;
  stopping: boolean;
  logSize: number;
  // Log bytes already searched for step markers.
  scanned: number;
  tail: string;
  sent: string;
};
type Folder = { store: Store; detected: { commands: RunCommand[]; pm: string | null; sources: string[]; at: number } | null; finding: boolean; findError?: string };
type Send = (m: RunServerMessage) => void;
type Client = { send: Send; folder: string | null; log: { folder: string; id: string } | null; logText: string };

const emptyStore = (): Store => ({ edits: {}, shortcuts: [], suggestions: [], dismissed: [], repeats: {}, runs: [], drain: [], seen: Date.now() });
const keyOf = (folder: string, id: string) => `${folder}\0${id}`;
const cmdKey = (c: { cwd: string; command: string }) => `${c.cwd}\0${c.command}`;
const today = () => new Date().toLocaleDateString('en-CA');
const alive = (r: Run) => r.state.phase === 'starting' || r.state.phase === 'running';
const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;

// ANSI codes and progress redraws out, markers out: what a person reads.
function clean(text: string) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '')
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r', l.length - 2) + 1).replace(/\r$/, ''))
    .filter((l) => !/^::cweb (step|exit) /.test(l))
    .join('\n');
}

// Error lines with the file:line just before each; package managers' "$ command" echoes are skipped.
function errorLines(tail: string) {
  const lines = clean(tail).split('\n').filter((l) => l.trim() && !l.startsWith('$ ')).slice(-80);
  const picked = new Set<number>();
  lines.forEach((l, i) => {
    if (!ERROR_LINE.test(l)) return;
    if (i > 0 && /\S+:\d+/.test(lines[i - 1]!)) picked.add(i - 1);
    picked.add(i);
  });
  const out = picked.size ? [...picked].sort((a, b) => a - b).map((i) => lines[i]!).slice(-12) : lines.slice(-8);
  return out.join('\n').slice(0, 4000);
}

const last = (re: RegExp, text: string) => [...text.matchAll(re)].pop();

// The last step marker in bytes [start, end) of the log, or to its end; the 64 KB tail a tick reads can miss it.
async function lastStep(log: string, start: number, end?: number) {
  let found: [number, number] | undefined;
  let carry = '';
  try {
    for await (const chunk of createReadStream(log, { encoding: 'utf8', start, ...(end === undefined ? {} : { end: end - 1 }) })) {
      const text = carry + (chunk as string);
      const m = last(STEP, text);
      if (m) found = [Number(m[1]), Number(m[2])];
      carry = text.slice(-32);
    }
  } catch {
    // A missing log leaves the saved step.
  }
  return found;
}

// A run's script: markers around the user's command, so steps and the exit code survive a server restart.
function script(c: RunCommand) {
  const end = `c=$?\nprintf '\\n::cweb exit %s::\\n' "$c"\nexit "$c"`;
  if (c.kind !== 'prod' || !c.build) return `${c.command}\n${end}`;
  return `printf '::cweb step 1/2::\\n'\n${c.build}\nc=$?\nif [ "$c" -ne 0 ]; then printf '\\n::cweb exit %s::\\n' "$c"; exit "$c"; fi\nprintf '::cweb step 2/2::\\n'\n${c.command}\n${end}`;
}

// The app's own variables stay out, so a project's dev server never takes tarcsweb's port.
function env() {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CW_') && k !== OWNED_ENV) out[k] = v;
  return out;
}

const SHELL_READS = /^(cd|ls|ll|cat|bat|less|grep|rg|ag|find|fd|head|tail|sed|awk|echo|printf|pwd|wc|which|type|file|stat|du|df|ps|top|kill|pkill|lsof|ss|sleep|jq|diff|tree|true|false|test|\[|git|gh|curl|wget|mkdir|touch|cp|mv|rm|ln|chmod|realpath|basename|dirname|date|env|export|source|\.)$/;

// A Bash call as a shortcut candidate: the command and its folder, or null for reads, pipes and one-off scripts.
function candidate(folder: string, raw: string) {
  let c = raw.trim().replace(/\s+2>&1\s*\|\s*(tail|head)(\s+-n?\s*\d+)?\s*$/, '').replace(/\s+2>&1$/, '');
  let cwd = '';
  const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*(.+)$/.exec(c);
  if (cd) {
    const dir = resolve(folder, cd[1]!.replace(/^["']|["']$/g, ''));
    const rel = relative(folder, dir);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    cwd = rel;
    c = cd[2]!;
  }
  if (!c || c.length > 160 || /[\n|;<>`]|\$\(|&&|\|\||&\s*$/.test(c)) return null;
  const word = c.split(/\s+/)[0]!;
  if (SHELL_READS.test(word) || /^[A-Z_]+=/.test(word)) return null;
  return { cwd, command: c };
}

class RunBar {
  private folders = new Map<string, Folder>();
  private runs = new Map<string, Run>();
  private clients = new Set<Client>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // save() calls so far, and how many of them the last finished write covered.
  private changes = 0;
  private saved = 0;
  private protectedPorts = new Set<number>();
  private protectedPids = new Set<number>();
  // Starts between their click and their spawn.
  private opening = new Set<string>();
  // Groups sent SIGTERM by Stop and not yet past their SIGKILL; saved, so a quit or the next boot finishes them.
  private draining = new Map<number, { folder: string; ticks: string }>();
  // Set by a quit: nothing starts, ticks or saves after it.
  private closed = false;
  // Set by the first client. Before it nothing is written or deleted, so an instance that fails to bind leaves the state alone.
  private joined = false;

  constructor() {
    let raw: Record<string, Partial<Store>> = {};
    try {
      raw = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch {
      // Missing or unreadable: start empty.
    }
    for (const [folder, s] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      const store = { ...emptyStore(), ...s };
      this.folders.set(folder, { store, detected: null, finding: false });
      // A Stop cut by the restart: its run is not adopted, and its group is killed only when a live leader with the
      // saved ticks proves it is ours. A gone leader is left alone, since its pid may now be another group's.
      const drain = new Set<string>();
      for (const d of store.drain) {
        if (!(d.pid > 1) || !d.ticks) continue;
        drain.add(`${d.pid}:${d.ticks}`);
        if (startTicksSync(d.pid) !== d.ticks) continue;
        try {
          process.kill(-d.pid, 'SIGKILL');
        } catch {}
      }
      for (const saved of store.runs) if (!drain.has(`${saved.pid}:${saved.ticks}`)) void this.adopt(folder, saved);
      store.runs = [];
      store.drain = [];
    }
    process.on('exit', () => this.flush());
  }

  // tarcsweb's own ports, and the server with its parents (the launcher), are never offered to stop.
  protect(ports: number[]) {
    // The live app's ports too, so a test instance on a spare port never offers to stop it.
    for (const p of [...ports, 24816, 24817]) this.protectedPorts.add(p);
    void (async () => {
      for (let pid = process.pid; pid > 1; pid = await parentOf(pid)) this.protectedPids.add(pid);
    })();
  }

  join(send: Send) {
    const client: Client = { send, folder: null, log: null, logText: '' };
    this.clients.add(client);
    if (!this.joined) {
      this.joined = true;
      if (this.changes !== this.saved) this.save();
      // Finished runs are not saved, so logs no run points to are unreachable after a restart.
      const kept = new Set([...this.runs.values()].map((r) => r.log));
      void readdir(LOGS).then(async (names) => {
        for (const name of names) {
          const path = join(LOGS, name);
          const st = kept.has(path) ? null : await stat(path).catch(() => null);
          if (st && Date.now() - st.mtimeMs > LOG_KEEP_MS) await unlink(path).catch(() => {});
        }
      }, () => {});
    }
    return {
      handle: (m: RunClientMessage) => this.handle(client, m),
      leave: () => {
        this.clients.delete(client);
        this.schedule();
      },
    };
  }

  private folder(path: string) {
    let f = this.folders.get(path);
    if (!f) {
      f = { store: emptyStore(), detected: null, finding: false };
      this.folders.set(path, f);
      this.evict();
    }
    f.store.seen = Date.now();
    return f;
  }

  private evict() {
    if (this.folders.size <= FOLDERS_MAX) return;
    const live = new Set([...this.runs.values()].filter(alive).map((r) => r.folder));
    const old = [...this.folders].filter(([p]) => !live.has(p)).sort((a, b) => a[1].store.seen - b[1].store.seen);
    for (const [p] of old.slice(0, this.folders.size - FOLDERS_MAX)) {
      this.folders.delete(p);
      for (const r of [...this.runs.values()]) if (r.folder === p) this.forget(p, r.cmd.id);
    }
  }

  // Drops a finished run and its log file.
  private forget(folder: string, id: string) {
    const run = this.runs.get(keyOf(folder, id));
    if (!run || alive(run)) return;
    this.runs.delete(keyOf(folder, id));
    if (run.log) void unlink(run.log).catch(() => {});
  }

  private async detected(path: string, fresh = false) {
    const f = this.folder(path);
    if (fresh || !f.detected || Date.now() - f.detected.at > DETECT_TTL) f.detected = { ...(await detect(path)), at: Date.now() };
    return f.detected;
  }

  // Detected commands and shortcuts with the user's edits, plus any run whose command is gone.
  private commands(path: string) {
    const f = this.folder(path);
    const all = [...(f.detected?.commands ?? []), ...f.store.shortcuts].map((c) => {
      const e = f.store.edits[c.id];
      return e ? { ...c, ...e } : c;
    });
    for (const r of this.runs.values()) if (r.folder === path && alive(r) && !all.some((c) => c.id === r.cmd.id)) all.push(r.cmd);
    return all;
  }

  private view(path: string): RunFolder {
    const f = this.folder(path);
    const runs = [...this.runs.values()];
    return {
      folder: path,
      pm: f.detected?.pm ?? null,
      sources: f.detected?.sources ?? [],
      commands: this.commands(path),
      suggestions: f.store.suggestions,
      runs: runs.filter((r) => r.folder === path).map((r) => r.state),
      elsewhere: runs.filter((r) => r.folder !== path && alive(r) && r.cmd.kind !== 'action').length,
      finding: f.finding,
      ...(f.findError ? { findError: f.findError } : {}),
    };
  }

  // One snapshot per watched folder, the same object for each client in it.
  private broadcast() {
    const views = new Map<string, RunServerMessage>();
    for (const c of this.clients) {
      if (!c.folder) continue;
      let m = views.get(c.folder);
      if (!m) views.set(c.folder, (m = { type: 'run-folder', folder: this.view(c.folder) }));
      c.send(m);
    }
  }

  private async handle(client: Client, m: RunClientMessage) {
    if (m.type === 'run-open') return openUrl(m.url);
    if (m.type === 'run-watch') {
      client.folder = m.folder;
      // The client drops its open log on a folder switch; stop streaming it here too.
      if (client.log && client.log.folder !== m.folder) {
        client.log = null;
        client.logText = '';
      }
      if (!m.folder) return;
      await this.detected(m.folder);
      if (client.folder === m.folder) client.send({ type: 'run-folder', folder: this.view(m.folder) });
      return;
    }
    const f = this.folder(m.folder);
    const run = this.runs.get(keyOf(m.folder, 'id' in m && m.id ? m.id : ''));
    switch (m.type) {
      case 'run-start':
        return this.start(m.folder, m.id);
      case 'run-stop':
        return this.stop(m.folder, m.id);
      case 'run-start-all':
        for (const c of this.commands(m.folder)) if (c.kind === 'service' && !c.hidden) await this.start(m.folder, c.id);
        return;
      case 'run-log':
        client.log = m.id ? { folder: m.folder, id: m.id } : null;
        client.logText = '';
        // Unwatched ticks skip the tail, so it is read fresh here.
        if (run) run.tail = '';
        if (m.id) await this.sendLog(client);
        this.schedule();
        return;
      case 'run-full-log': {
        const t = run?.log ? await tailFile(run.log).catch(() => ({ text: '', truncated: false })) : { text: '', truncated: false };
        const text = clean(t.text);
        client.send({ type: 'run-full-log', folder: m.folder, id: m.id, text: text ? `${t.truncated ? '(Earlier output cut; this is the last 64 KB.)\n\n' : ''}${text}` : 'The log is empty.' });
        return;
      }
      case 'run-edit': {
        const next = { ...f.store.edits[m.id], ...m.edit };
        if (!next.label) delete next.label;
        delete f.store.edits[m.id];
        f.store.edits[m.id] = next;
        const ids = Object.keys(f.store.edits);
        for (const k of ids.slice(0, Math.max(0, ids.length - EDITS_MAX))) delete f.store.edits[k];
        break;
      }
      case 'run-remove':
        if (run && alive(run)) return;
        f.store.shortcuts = f.store.shortcuts.filter((c) => c.id !== m.id);
        delete f.store.edits[m.id];
        this.forget(m.folder, m.id);
        break;
      case 'run-suggestion': {
        const s = f.store.suggestions.find((x) => x.id === m.id);
        if (!s) return;
        // Changed by an agent after the card was drawn: the fresh snapshot shows the new command instead.
        if (m.accept && (m.command !== s.command || m.cwd !== s.cwd)) return client.send({ type: 'run-folder', folder: this.view(m.folder) });
        f.store.suggestions = f.store.suggestions.filter((x) => x !== s);
        if (m.accept) {
          const { why: _why, ...cmd } = s;
          const next = [...f.store.shortcuts.filter((c) => c.id !== cmd.id), cmd];
          f.store.shortcuts = next.slice(-SHORTCUTS_MAX);
          // Evicted shortcuts have no row left to remove them from, so their edits, runs and logs go too.
          for (const c of next.slice(0, -SHORTCUTS_MAX)) {
            delete f.store.edits[c.id];
            this.forget(m.folder, c.id);
          }
        } else f.store.dismissed = [...f.store.dismissed.filter((k) => k !== cmdKey(s)), cmdKey(s)].slice(-DISMISSED_MAX);
        break;
      }
      case 'run-find':
        return this.find(m.folder);
      case 'run-free-port':
        return this.freePort(m.folder, m.id, m.pid);
    }
    this.save();
    this.broadcast();
  }

  private async start(folder: string, id: string) {
    // A start can arrive before run-watch detected the folder, as after a server restart.
    await this.detected(folder);
    const key = keyOf(folder, id);
    const prev = this.runs.get(key);
    // Two windows clicking at once must not both pass the port check and spawn twice.
    if ((prev && alive(prev)) || this.opening.has(key)) return;
    const cmd = this.commands(folder).find((c) => c.id === id);
    if (!cmd) return;
    this.opening.add(key);
    try {
      // Compose publishes its ports through docker-proxy, and a container already up is simply attached to.
      if (cmd.port && cmd.kind !== 'action' && cmd.source !== 'compose' && [...(await listening()).values()].includes(cmd.port)) {
        const holder = await this.holder(cmd.port);
        if (holder) {
          this.runs.set(key, this.blank(folder, cmd, { phase: 'blocked', holder }));
          return this.broadcast();
        }
      }
      await this.spawn(folder, cmd);
    } finally {
      this.opening.delete(key);
    }
  }

  private blank(folder: string, cmd: RunCommand, state: Partial<RunState>): Run {
    return { folder, cmd, pid: 0, ticks: '', log: '', child: null, stopping: false, logSize: 0, scanned: 0, tail: '', sent: '', state: { id: cmd.id, phase: 'stopped', startedAt: Date.now(), ports: [], mb: null, ...state } };
  }

  private async holder(port: number): Promise<RunHolder | null> {
    const h = await holderOf(port);
    if (!h) return null;
    for (const r of this.runs.values()) {
      if (alive(r) && r.pid && (await tree(r.pid)).includes(h.pid)) return { pid: h.pid, name: r.cmd.label, port, stoppable: true };
    }
    let own = this.protectedPorts.has(port) || this.protectedPids.has(h.pid);
    // The server's own children (CLIs, the panel's Chrome) count as tarcsweb too.
    for (let p = h.pid, i = 0; !own && p > 1 && i < 64; p = await parentOf(p), i++) own = p === process.pid;
    return { pid: h.pid, name: own ? 'tarcsweb' : h.name, port, stoppable: !own && h.pid > 1 };
  }

  private async spawn(folder: string, cmd: RunCommand) {
    const key = keyOf(folder, cmd.id);
    // Hashing the full key keeps ids that differ only in replaced or cut characters apart.
    const log = join(LOGS, `${createHash('sha1').update(key).digest('hex').slice(0, 16)}-${cmd.id.replace(/[^\w.-]/g, '_').slice(0, 60)}.log`);
    const run = this.blank(folder, cmd, { phase: 'starting', ...(cmd.kind === 'prod' && cmd.build ? { step: [1, 2] as [number, number] } : {}) });
    run.log = log;
    this.runs.set(key, run);
    const fail = (why: string) => {
      run.state = { ...run.state, phase: 'failed', exit: null, endedAt: Date.now(), errors: why };
      this.broadcast();
    };
    let fh;
    try {
      await mkdir(LOGS, { recursive: true });
      await writeFile(log, '');
      fh = await open(log, 'a');
    } catch (e) {
      return fail(`Could not open the log: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (run.stopping) return void fh.close();
    if (this.closed) {
      void fh.close();
      return fail('tarcsweb is quitting');
    }
    const child = spawn('/bin/sh', ['-c', script(cmd)], { cwd: join(folder, cmd.cwd), detached: true, stdio: ['ignore', fh.fd, fh.fd], env: env() });
    void fh.close();
    child.on('error', (e) => fail(e.message));
    child.on('exit', (code) => void this.ended(run, code));
    child.unref();
    if (!child.pid) return;
    run.child = child;
    run.pid = child.pid;
    // Sync on a Start click, not a streaming path: no await gap leaves the run saved without its ticks.
    run.ticks = startTicksSync(child.pid) ?? '';
    this.save();
    this.broadcast();
    this.schedule();
  }

  private async adopt(folder: string, saved: Saved) {
    // Starting until a tick reads its ports and log, so a build cut by the restart is not shown as running.
    const build = saved.cmd.kind === 'prod' && !!saved.cmd.build;
    const run = this.blank(folder, saved.cmd, { phase: 'starting', startedAt: saved.startedAt, ...(build ? { step: saved.step ?? ([1, 2] as [number, number]) } : {}) });
    Object.assign(run, { pid: saved.pid, ticks: saved.ticks, log: saved.log });
    this.runs.set(keyOf(folder, saved.cmd.id), run);
    // The saved step survives the log cap; a tick scans the whole log for a step reached while the server was down.
    if ((await startTicks(saved.pid)) !== saved.ticks) return this.ended(run, null);
    this.save();
    this.schedule();
  }

  private async ended(run: Run, code: number | null) {
    if (!alive(run) || this.runs.get(keyOf(run.folder, run.cmd.id)) !== run) return;
    // Not alive from here on, so the exit event and a tick never both end it.
    run.state = { ...run.state, phase: 'stopped' };
    run.child = null;
    const tail = (await tailFile(run.log).catch(() => ({ text: '' }))).text;
    run.tail = tail;
    const marked = last(EXIT, tail);
    const exit = marked ? Number(marked[1]) : code;
    const failed = !run.stopping && exit !== 0;
    run.state = { ...run.state, phase: run.stopping ? 'stopped' : failed ? 'failed' : 'done', exit, endedAt: Date.now(), ports: [], mb: null };
    if (failed) {
      run.state.errors = errorLines(tail);
      const busy = IN_USE.exec(clean(tail));
      const port = busy ? Number(busy[1] ?? busy[2]) : 0;
      const holder = port ? await this.holder(port) : null;
      if (holder) run.state.holder = holder;
    }
    // A shortcut evicted or removed while it ran has no row left, so its run and log go now.
    if (this.folders.get(run.folder)?.detected && !this.commands(run.folder).some((c) => c.id === run.cmd.id)) this.forget(run.folder, run.cmd.id);
    this.save();
    this.broadcast();
  }

  private stop(folder: string, id: string) {
    const run = this.runs.get(keyOf(folder, id));
    if (!run) return;
    if (!alive(run)) {
      this.runs.delete(keyOf(folder, id));
      return this.broadcast();
    }
    run.stopping = true;
    const pid = run.pid;
    // No pid yet: kill(-0) would signal tarcsweb's own group. spawn sees stopping and never starts it.
    if (pid <= 0) {
      run.state = { ...run.state, phase: 'stopped', endedAt: Date.now() };
      return this.broadcast();
    }
    // A reused pid means the group is no longer ours. Sync is fine: this runs on a Stop click.
    const ticks = startTicksSync(pid);
    if (ticks !== null && run.ticks && ticks !== run.ticks) return void this.ended(run, null);
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      return void this.ended(run, null);
    }
    this.draining.set(pid, { folder, ticks: run.ticks });
    this.save();
    // The wrapper shell may exit first; whatever is left in its group is killed anyway.
    setTimeout(() => {
      this.draining.delete(pid);
      this.save();
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }, KILL_MS).unref();
  }

  // Stops what holds the port (one of ours by its run, anything else by its pid), waits for the port, then starts.
  private async freePort(folder: string, id: string, pid: number) {
    const key = keyOf(folder, id);
    const run = this.runs.get(key);
    const shown = run?.state.holder;
    if (!run || !shown || shown.pid !== pid || !shown.stoppable) return;
    // The card may be old: the port's holder now must be the same process, still stoppable.
    const h = await this.holder(shown.port);
    if (!h || h.pid !== pid || !h.stoppable) {
      run.state = { ...run.state, holder: h ?? undefined, errors: h ? 'Another process holds the port now.' : undefined };
      if (!h && run.state.phase === 'blocked') this.runs.delete(key);
      return this.broadcast();
    }
    let ours: Run | undefined;
    for (const r of this.runs.values()) if (r !== run && alive(r) && r.pid && (await tree(r.pid)).includes(pid)) ours = r;
    try {
      if (ours) this.stop(ours.folder, ours.cmd.id);
      else process.kill(pid, 'SIGTERM');
    } catch (e) {
      run.state = { ...run.state, errors: `Could not stop ${h.name}: ${e instanceof Error ? e.message : String(e)}` };
      return this.broadcast();
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 250));
      // Cancel (or another start) while waiting drops this run, and nothing starts.
      if (this.runs.get(key) !== run) return;
      if (![...(await listening()).values()].includes(h.port)) {
        this.runs.delete(key);
        return this.start(folder, id);
      }
    }
    run.state = { ...run.state, errors: `Port :${h.port} is still in use.` };
    this.broadcast();
  }

  // One timer for every run: process trees, memory, ports, prod steps and open logs.
  private schedule() {
    const busy = [...this.runs.values()].some(alive) || [...this.clients].some((c) => c.log && this.runs.get(keyOf(c.log.folder, c.log.id))?.state.phase === 'running');
    if (!busy || this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule());
    }, tuning().runMs);
  }

  private async tick() {
    const listen = await listening();
    const stats = new Map<string, { id: string; ports: number[]; mb: number | null }[]>();
    let changed = false;
    for (const run of this.runs.values()) {
      // A spawn still opening its log has no pid; /proc/0 would read as an ended run.
      if (!alive(run) || run.pid <= 0) continue;
      if (!run.child && (await startTicks(run.pid)) !== run.ticks) {
        await this.ended(run, null);
        continue;
      }
      const pids = await tree(run.pid);
      const mb = await memoryMb(pids);
      const ports = run.cmd.source === 'compose' ? (run.cmd.port && [...listen.values()].includes(run.cmd.port) ? [run.cmd.port] : []) : await portsOf(pids, listen);
      const size = (await stat(run.log).catch(() => null))?.size ?? 0;
      const watched = [...this.clients].some((c) => c.log?.folder === run.folder && c.log.id === run.cmd.id);
      if (size !== run.logSize && (watched || run.state.phase === 'starting')) run.tail = (await tailFile(run.log).catch(() => ({ text: '' }))).text;
      run.logSize = size;
      // Markers are searched by byte offset while building, so one past the tail or the log cap is still seen.
      let scan: [number, number] | undefined;
      const scanning = run.state.step && run.state.step[0] < run.state.step[1];
      const cut = size > LOG_MAX;
      if (size < run.scanned) run.scanned = 0;
      // Before a cut the scan runs to the file's current end, so markers written since the stat are kept.
      if (scanning && (cut || size > run.scanned)) {
        scan = await lastStep(run.log, Math.max(0, run.scanned - 32), cut ? undefined : size);
        run.scanned = size;
      }
      if (cut) {
        await truncate(run.log, 0).catch(() => {});
        run.scanned = 0;
      }
      // It may have ended during the reads above.
      if (!alive(run)) continue;
      const s = run.state;
      const step = run.cmd.kind === 'prod' ? last(STEP, run.tail) : undefined;
      const tailStep: [number, number] | undefined = step ? [Number(step[1]), Number(step[2])] : undefined;
      // Steps only move forward, so the furthest one seen wins.
      const nextStep = [tailStep, scan].reduce((a, b) => (b && (!a || b[0] > a[0]) ? b : a), s.step);
      const building = run.cmd.kind === 'prod' && nextStep && nextStep[0] < nextStep[1];
      const up = s.phase === 'running' || (run.cmd.kind !== 'action' && !building && (ports.length > 0 || READY.test(clean(run.tail).slice(-4000)) || (!run.cmd.port && Date.now() - s.startedAt > SETTLE_MS)));
      const phase = up ? 'running' : 'starting';
      if (phase !== s.phase || nextStep?.[0] !== s.step?.[0]) {
        run.state = { ...s, phase, ports, mb, ...(nextStep ? { step: nextStep } : {}) };
        changed = true;
      } else if (mb !== s.mb || ports.join() !== s.ports.join()) {
        run.state = { ...s, ports, mb };
        const list = stats.get(run.folder) ?? [];
        list.push({ id: s.id, ports, mb });
        stats.set(run.folder, list);
      }
    }
    if (changed) {
      // Saves the step, so a restart after the log cap still knows the build finished.
      this.save();
      this.broadcast();
    } else for (const c of this.clients) {
      const list = c.folder ? stats.get(c.folder) : undefined;
      if (list && c.folder) c.send({ type: 'run-stats', folder: c.folder, stats: list });
    }
    for (const c of this.clients) if (c.log) await this.sendLog(c);
  }

  private async sendLog(c: Client) {
    const sub = c.log;
    const run = sub && this.runs.get(keyOf(sub.folder, sub.id));
    if (!run || !sub) return;
    if (!run.tail && run.log) run.tail = (await tailFile(run.log).catch(() => ({ text: '' }))).text;
    // run-watch or run-log may have changed the subscription during the read.
    if (c.log !== sub) return;
    const text = clean(run.tail).split('\n').slice(-LOG_LINES).join('\n').trimEnd();
    if (text === c.logText) return;
    c.logText = text;
    c.send({ type: 'run-log', folder: sub.folder, id: sub.id, text });
  }

  private save() {
    this.changes++;
    if (this.saveTimer || this.closed || !this.joined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write(true);
    }, 400);
  }

  // keepRuns false writes no live runs, so the next boot adopts none.
  private snapshot(keepRuns: boolean) {
    const out: Record<string, Store> = {};
    for (const [path, f] of this.folders) {
      const runs = !keepRuns ? [] : [...this.runs.values()].filter((r) => r.folder === path && alive(r) && r.pid).map((r) => ({ id: r.cmd.id, pid: r.pid, ticks: r.ticks, startedAt: r.state.startedAt, log: r.log, cmd: r.cmd, step: r.state.step }));
      const drain = !keepRuns ? [] : [...this.draining].filter(([, d]) => d.folder === path).map(([pid, d]) => ({ pid, ticks: d.ticks }));
      out[path] = { ...f.store, runs, drain };
    }
    return JSON.stringify(out);
  }

  // Temp file, then rename: a crash mid-write leaves the previous state, never a cut one.
  private write(keepRuns: boolean) {
    const text = this.snapshot(keepRuns);
    const at = this.changes;
    return (this.writing = this.writing
      .then(() => mkdir(DIR, { recursive: true }))
      .then(() => writeFile(`${FILE}.tmp`, text))
      .then(() => rename(`${FILE}.tmp`, FILE))
      .then(() => {
        this.saved = Math.max(this.saved, at);
      })
      .catch((err) => console.error('run bar: saving state failed', err)));
  }

  // A signal exits without waiting for the debounced or in-flight save; its own temp file avoids that write.
  private flush() {
    if (this.closed || !this.joined || this.saved === this.changes) return;
    try {
      // An in-flight async rename of the older .tmp could land after ours; taking its source makes it fail instead.
      try {
        unlinkSync(`${FILE}.tmp`);
      } catch {}
      mkdirSync(DIR, { recursive: true });
      writeFileSync(`${FILE}.exit.tmp`, this.snapshot(true));
      renameSync(`${FILE}.exit.tmp`, FILE);
    } catch (err) {
      console.error('run bar: saving state at exit failed', err);
    }
  }

  // Runs a quit would stop, for its confirmation.
  live() {
    return [...this.runs.values()].filter(alive).map((r) => ({ folder: r.folder, label: r.cmd.label }));
  }

  // Quit tarcsweb: runs are detached so a restart adopts them, but a quit stops every group and saves none.
  async stopAll() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.timer = this.saveTimer = null;
    const groups = new Set(this.draining.keys());
    for (const r of this.runs.values()) {
      if (!alive(r) || r.pid <= 0) continue;
      r.stopping = true;
      // A live leader that started at another time is a reused pid, not our run.
      const ticks = await startTicks(r.pid);
      if (ticks === null || !r.ticks || ticks === r.ticks) groups.add(r.pid);
    }
    let left = [...groups];
    const signal = (sig: NodeJS.Signals | 0) => (left = left.filter((pid) => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        return false;
      }
    }));
    signal('SIGTERM');
    for (const end = Date.now() + KILL_MS; left.length && Date.now() < end; signal(0)) await new Promise((r) => setTimeout(r, 100));
    signal('SIGKILL');
    await this.write(false);
  }

  private known(path: string, key: string) {
    const f = this.folder(path);
    return this.commands(path).some((c) => cmdKey(c) === key) || f.store.suggestions.some((s) => cmdKey(s) === key) || f.store.dismissed.includes(key);
  }

  private suggest(path: string, s: RunSuggestion) {
    const f = this.folder(path);
    f.store.suggestions = [...f.store.suggestions.filter((x) => x.id !== s.id), s].slice(-SUGGESTIONS_MAX);
    this.save();
    this.broadcast();
  }

  // Every main-agent Bash call in a folder; the third run of one command in a day suggests it as a shortcut.
  async sawCommand(path: string, raw: string) {
    const c = candidate(path, raw);
    if (!c) return;
    const key = cmdKey(c);
    await this.detected(path);
    if (this.known(path, key)) return;
    const f = this.folder(path);
    const day = today();
    const prev = f.store.repeats[key];
    const n = prev?.day === day ? prev.n + 1 : 1;
    delete f.store.repeats[key];
    f.store.repeats[key] = { day, n };
    const keys = Object.keys(f.store.repeats);
    for (const k of keys.slice(0, Math.max(0, keys.length - REPEATS_MAX))) delete f.store.repeats[k];
    this.save();
    if (n !== REPEATS) return;
    const service = /\b(dev|serve|watch|start)\b|\bup\b(?!.*\s-d\b)/.test(c.command);
    this.suggest(path, {
      id: `rp:${randomUUID().slice(0, 8)}`, label: c.command.slice(0, 40), ...c, kind: service ? 'service' : 'action',
      destructive: DESTRUCTIVE.test(c.command), source: 'repeat', why: `Agents ran \`${c.command}\` ${REPEATS} times today`,
    });
  }

  // The app tool: an agent lists, suggests, updates or removes this folder's shortcuts. Returns the model's text.
  async agent(path: string, a: { action: 'list' | 'add' | 'update' | 'remove'; id?: string; label?: string; command?: string; cwd?: string; kind?: 'service' | 'action'; destructive?: boolean }) {
    await this.detected(path);
    const f = this.folder(path);
    const all = this.commands(path);
    if (a.action === 'list') {
      const rows = all.map((c) => `- ${c.id} · ${c.kind} · ${c.label}: ${c.command}${c.cwd ? ` (in ${c.cwd})` : ''} [${c.source}${c.hidden ? ', hidden' : ''}]`);
      const sug = f.store.suggestions.map((s) => `- ${s.id} · ${s.kind} · ${s.label}: ${s.command} (waiting for the user)`);
      return [`Project commands in ${path}:`, ...(rows.length ? rows : ['(none)']), ...(sug.length ? ['Suggestions:', ...sug] : [])].join('\n');
    }
    if (a.action === 'remove') {
      if (!a.id) throw new Error('remove needs the id from list.');
      const run = this.runs.get(keyOf(path, a.id));
      if (run && alive(run)) throw new Error('That command is running; the user must stop it first.');
      const had = f.store.shortcuts.length + f.store.suggestions.length;
      f.store.shortcuts = f.store.shortcuts.filter((c) => c.id !== a.id);
      f.store.suggestions = f.store.suggestions.filter((c) => c.id !== a.id);
      if (had === f.store.shortcuts.length + f.store.suggestions.length) throw new Error('No shortcut with that id. Commands found in project files cannot be removed; the user can hide them.');
      this.forget(path, a.id);
      this.save();
      this.broadcast();
      return 'Removed.';
    }
    const base = a.action === 'update' ? [...f.store.shortcuts, ...f.store.suggestions].find((c) => c.id === a.id) : undefined;
    if (a.action === 'update' && !base) throw new Error('update works on shortcuts and suggestions only; give the id from list.');
    const label = (a.label ?? base?.label ?? '').trim();
    const command = (a.command ?? base?.command ?? '').trim();
    if (!str(label, 60) || !str(command, 2000)) throw new Error('label (up to 60 characters) and command are required.');
    const cwd = a.cwd === undefined ? base?.cwd ?? '' : relative(path, resolve(path, a.cwd));
    if (cwd.startsWith('..') || isAbsolute(cwd)) throw new Error('cwd must be inside the session folder.');
    const kind: RunKind = a.kind ?? (base?.kind === 'service' ? 'service' : 'action');
    const key = cmdKey({ cwd, command });
    if (a.action === 'add' && this.commands(path).some((c) => cmdKey(c) === key)) throw new Error('That command is already a button.');
    const why = a.action === 'update' ? 'An agent wants to change this button' : 'Suggested by an agent';
    this.suggest(path, {
      id: base?.id ?? `sc:${randomUUID().slice(0, 8)}`, label, command, cwd, kind,
      destructive: !!(a.destructive ?? base?.destructive) || DESTRUCTIVE.test(`${label} ${command}`), source: 'agent', why,
    });
    return 'Shown to the user as a suggestion in the project commands card (the pill beside the message box). It becomes a button only when they accept it; do not run it yourself in its place.';
  }

  // The Find commands button: a small model reads the project files and suggests what detection missed.
  private async find(path: string) {
    const f = this.folder(path);
    if (f.finding) return;
    f.finding = true;
    delete f.findError;
    this.broadcast();
    try {
      const ctx = await finderContext(path);
      const prompt = `${ctx}\n\nList the commands a developer runs in this project: dev servers, build and start, database up/down/seed/reset, tests, lint. Reply with a JSON array only, each item {"label": short name, "command": shell command, "cwd": folder relative to the project root or "", "kind": "service" for long-running or "action" for one-shot, "destructive": true if it deletes data}. At most 12 items. Only commands the files support.`;
      const text = await ask(prompt, () => {}, 'You read project files and list their run commands. Reply with JSON only, no prose and no code fence.', { maxTokens: 1500, timeoutMs: FIND_TIMEOUT_MS });
      const start = text?.indexOf('[') ?? -1;
      const items: unknown[] = text && start >= 0 ? JSON.parse(text.slice(start, text.lastIndexOf(']') + 1)) : [];
      let added = 0;
      for (const it of Array.isArray(items) ? items.slice(0, 12) : []) {
        const o = it as Record<string, unknown>;
        if (!str(o.label, 60) || !str(o.command, 500)) continue;
        const cwd = typeof o.cwd === 'string' ? relative(path, resolve(path, o.cwd)) : '';
        if (cwd.startsWith('..') || isAbsolute(cwd) || this.known(path, cmdKey({ cwd, command: o.command as string }))) continue;
        const label = (o.label as string).trim();
        const command = (o.command as string).trim();
        f.store.suggestions = [...f.store.suggestions, {
          id: `fd:${randomUUID().slice(0, 8)}`, label, command, cwd, kind: o.kind === 'service' ? 'service' : 'action',
          destructive: o.destructive === true || DESTRUCTIVE.test(`${label} ${command}`), source: 'finder', why: 'Found by the command finder',
        } satisfies RunSuggestion].slice(-SUGGESTIONS_MAX);
        added++;
      }
      if (!added) f.findError = text === null ? "Couldn't reach the model, try again" : 'Nothing new found';
    } catch (e) {
      f.findError = `Couldn't find commands: ${e instanceof Error ? e.message : String(e)}`;
    }
    f.finding = false;
    this.save();
    this.broadcast();
  }
}

// Opens in the user's Chrome as a normal tab.
async function openUrl(url: string) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) return;
  await openTab(url, await isWslHost());
}

const TYPES = new Set(['run-watch', 'run-start', 'run-stop', 'run-start-all', 'run-log', 'run-full-log', 'run-edit', 'run-remove', 'run-suggestion', 'run-find', 'run-free-port', 'run-open']);

// The socket's check for run-* messages: the right fields with bounded sizes, or null.
export function validRun(m: Record<string, unknown>): RunClientMessage | null {
  if (!TYPES.has(m.type as string)) return null;
  if (m.type === 'run-open') return str(m.url, 2000) ? (m as RunClientMessage) : null;
  if (m.type === 'run-watch') return m.folder === null || (str(m.folder, 4096) && isAbsolute(m.folder as string)) ? (m as RunClientMessage) : null;
  if (!str(m.folder, 4096) || !isAbsolute(m.folder as string)) return null;
  if (m.type === 'run-start-all' || m.type === 'run-find') return m as RunClientMessage;
  if (m.type === 'run-log' && m.id === null) return m as RunClientMessage;
  if (!str(m.id, 200)) return null;
  if (m.type === 'run-edit') {
    const e = m.edit as Record<string, unknown> | null;
    const ok = !!e && typeof e === 'object' && (e.label === undefined || (typeof e.label === 'string' && e.label.length <= 80))
      && (e.hidden === undefined || typeof e.hidden === 'boolean') && (e.pinned === undefined || typeof e.pinned === 'boolean');
    if (!ok) return null;
    // Only the fields sent, so a rename keeps the command's hidden and pinned state.
    const edit: RunEdit = {};
    if (e!.label !== undefined) edit.label = e!.label as string;
    if (e!.hidden !== undefined) edit.hidden = e!.hidden as boolean;
    if (e!.pinned !== undefined) edit.pinned = e!.pinned as boolean;
    return { type: 'run-edit', folder: m.folder as string, id: m.id as string, edit };
  }
  if (m.type === 'run-suggestion') {
    const seen = m.accept === true && str(m.command, 2000) && typeof m.cwd === 'string' && m.cwd.length <= 4096;
    return m.accept === false || seen ? (m as RunClientMessage) : null;
  }
  if (m.type === 'run-free-port') return Number.isInteger(m.pid) && (m.pid as number) > 1 ? (m as RunClientMessage) : null;
  return m as RunClientMessage;
}

export const runbar = new RunBar();
