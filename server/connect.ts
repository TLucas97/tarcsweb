import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import type { ConnectStatus } from './protocol.ts';

type Run = { out: string; err: Error | null };
const run = (file: string, args: string[]) =>
  new Promise<Run>((done) => execFile(file, args, { timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout) => done({ out: String(stdout), err })));

async function onPath(name: string) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      await access(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

// The binary the SDK spawns: CW_CLAUDE_BIN, else its per-platform package, looked up the way the SDK does.
export function sdkBinary() {
  if (process.env.CW_CLAUDE_BIN) return process.env.CW_CLAUDE_BIN;
  const req = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const pkg of process.platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    try {
      return req.resolve(`${pkg}/claude${ext}`);
    } catch {}
  }
  return null;
}

// What sign-in and sign-out run: the installed CLI, else the SDK's own copy. Both share the CLI's config dir.
export async function authBinary() {
  return (await onPath('claude')) ?? sdkBinary();
}

export const firstLine = (s: string) => s.trim().split('\n')[0].slice(0, 200);

const planName = (v: unknown) => (typeof v === 'string' && v.trim() ? `Claude ${v.trim()[0].toUpperCase()}${v.trim().slice(1)}` : null);

// Checked at boot and on request only; every client gets the cached result.
class Connect {
  status: ConnectStatus | null = null;
  private running: Promise<ConnectStatus> | null = null;
  private listeners = new Set<(s: ConnectStatus) => void>();

  subscribe(fn: (s: ConnectStatus) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  check() {
    this.running ??= this.probe().then((s) => {
      this.running = null;
      this.emit(s);
      return s;
    });
    return this.running;
  }

  // After a sign-in change: a probe already running may have read the old state.
  recheck() {
    return (this.running ?? Promise.resolve()).then(() => this.check());
  }

  private emit(s: ConnectStatus) {
    this.status = s;
    for (const fn of this.listeners) fn(s);
  }

  private async probe(): Promise<ConnectStatus> {
    const cliPath = await onPath('claude');
    // Login lives in the CLI's config dir (~/.claude), which the SDK's own binary shares with the installed CLI.
    const bin = sdkBinary() ?? cliPath;
    const [version, auth] = await Promise.all([cliPath ? run(cliPath, ['--version']) : null, bin ? run(bin, ['auth', 'status', '--json']) : null]);
    let loggedIn = false;
    let method: string | null = null;
    let email: string | null = null;
    let plan: string | null = null;
    let error: string | null = bin ? null : 'No claude binary found';
    if (auth) {
      try {
        const j = JSON.parse(auth.out) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown; subscriptionType?: unknown };
        loggedIn = j.loggedIn === true;
        method = typeof j.authMethod === 'string' && j.authMethod !== 'none' ? j.authMethod : null;
        email = loggedIn && typeof j.email === 'string' && j.email.trim() ? j.email.trim() : null;
        plan = loggedIn ? planName(j.subscriptionType) : null;
      } catch {
        error = auth.err ? firstLine(auth.err.message) : 'Could not read the sign-in status';
      }
    }
    const v = version && !version.err ? version.out.match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
    return { cli: cliPath ? { path: cliPath, version: v } : null, loggedIn, method, email, plan, error, checkedAt: Date.now() };
  }
}

export const connect = new Connect();
