import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { onPath } from '../connect.ts';

export type OpencodeBinary = { path: string | null; version: string | null; versionOk: boolean };
export type OpencodeEndpoint = { url: string; authorization: string };

export async function checkBinary(): Promise<OpencodeBinary> {
  const path = await onPath('opencode');
  if (!path) return { path: null, version: null, versionOk: false };
  const version = await new Promise<string | null>((resolve) => {
    execFile(path, ['--version'], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim().match(/^(?:opencode\s+)?v?(\d+\.\d+\.\d+)(?:[-+].*)?$/)?.[1] ?? null);
    });
  });
  return { path, version, versionOk: version?.split('.')[0] === '2' };
}

class OpencodeServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<OpencodeEndpoint> | null = null;
  private stopping: Promise<void> | null = null;
  private tail = '';

  constructor() {
    // index.ts exits explicitly after its shutdown budget, so signal the owned child on every exit path.
    process.once('exit', () => this.child?.kill('SIGTERM'));
  }

  get pid() { return this.child?.pid ?? null; }
  get running() { return this.child !== null; }

  async start(): Promise<OpencodeEndpoint> {
    if (this.stopping) await this.stopping;
    this.ready ??= this.boot().catch(async (error: unknown) => {
      await this.stopChild();
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async boot(): Promise<OpencodeEndpoint> {
    const binary = await checkBinary();
    if (!binary.path) throw new Error('The opencode CLI is not installed');
    if (!binary.versionOk) throw new Error(`OpenCode 2.x is required; found ${binary.version ?? 'an unknown version'}`);
    const password = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_PASSWORD: password };
    delete env.OPENCODE_SERVER_PASSWORD;
    this.tail = '';
    const child = spawn(binary.path, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { env, stdio: 'pipe' });
    this.child = child;
    let url: string | null = null;
    const state: { failure: Error | null } = { failure: null };
    const collect = (chunk: Buffer) => {
      this.tail = (this.tail + chunk.toString('utf8').split(password).join('[redacted]')).slice(-16_384);
      url ??= this.tail.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? null;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => { state.failure = error; });
    child.once('exit', (code, signal) => {
      state.failure = new Error(`OpenCode stopped (${signal ?? code})`);
      if (this.child === child) { this.child = null; this.ready = null; }
    });
    const authorization = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (state.failure) throw new Error(`${state.failure.message}\n${this.tail}`);
      if (url) {
        try {
          const response = await fetch(`${url}/api/info`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
          if (response.status === 200) return { url, authorization };
          if (response.status !== 503) throw new Error(`OpenCode readiness returned HTTP ${response.status}`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('OpenCode readiness')) throw error;
        }
      }
      await delay(100);
    }
    throw new Error(`OpenCode did not become ready within 30 seconds\n${this.tail}`);
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      await this.ready?.catch(() => {});
      await this.stopChild();
    })().finally(() => { this.stopping = null; this.ready = null; });
    return this.stopping;
  }

  private async stopChild() {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    if (this.child === child) this.child = null;
  }
}

export const opencodeServer = new OpencodeServer();
