import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callCodex } from './codex/realtime.ts';
import { codexAccount } from './codex/account.ts';
import { tuning } from './profile.ts';
import { readingProgress } from './voiceText.ts';
import type { VoiceAudioMessage } from './protocol.ts';

const WORK = join(tmpdir(), 'tarcsweb-recap-work');
const INSTRUCTIONS = 'You are a read-aloud voice. Wait for the explicit reading request. Read only the text that request specifies, exactly once, then stop speaking. Do not acknowledge, greet, paraphrase, explain or add words. Do not use tools or delegate.';
type Job = {
  id: string; token: string; owner: WebSocket; script: string; path: string; tempPath: string; signal: AbortSignal;
  thread: string | null; transcript: string; complete: boolean; uploaded: boolean; spoken: boolean;
  voice: string | null; offering: boolean; cancelAnswer?: () => void; starting?: Promise<unknown>;
  finish: (error?: string) => void;
};

// Serialized by Voice's render queue; this transport never touches a real call's thread or resources.
export class CodexVoice {
  private native = new WeakSet<WebSocket>();
  private jobs = new Map<string, Job>();

  capability(owner: WebSocket, native: boolean) {
    if (native) this.native.add(owner);
    else this.native.delete(owner);
  }

  usable(owner: WebSocket) {
    const s = codexAccount.status;
    return this.native.has(owner) && owner.readyState === 1 && !!s?.signedIn && !!s.version && Number(s.version.split('.')[1]) >= 166;
  }

  private send(job: Job, message: VoiceAudioMessage) {
    if (job.owner.readyState === 1) job.owner.send(JSON.stringify(message));
  }

  async render(script: string, path: string, owner: WebSocket | undefined, signal: AbortSignal, voice: string | null): Promise<void> {
    if (!owner || !this.native.has(owner) || owner.readyState !== 1) throw new Error('Codex voice is not supported in this window.');
    if (!codexAccount.status) await codexAccount.check();
    if (!this.usable(owner)) throw new Error('Codex voice needs a supported Codex installation and a signed-in account.');
    if (signal.aborted) throw new Error('Voice cancelled.');
    const { voiceCodexMs, voiceAudioBytes, voiceTailMs } = tuning();
    await new Promise<void>((resolve, reject) => {
      const release = callCodex.hold();
      let settled = false;
      const id = randomUUID();
      const job: Job = {
        id, token: randomBytes(32).toString('hex'), owner, script, path, tempPath: `${path}.${id}.part`, signal,
        thread: null, transcript: '', complete: false, uploaded: false, spoken: false, voice, offering: false,
        finish: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          off(); offExit();
          job.cancelAnswer?.();
          this.jobs.delete(id);
          this.send(job, { type: 'voice-audio', id, state: 'stop' });
          const stop = job.thread ? (job.starting ?? Promise.resolve()).catch(() => {}).then(() => callCodex.request('thread/realtime/stop', { threadId: job.thread! }, tuning().callStopMs)).catch(() => {}).then(() => callCodex.request('thread/unsubscribe', { threadId: job.thread! }).catch(() => {})) : Promise.resolve();
          void stop.finally(release);
          if (error) {
            void rm(job.tempPath, { force: true }).then(() => reject(new Error(error)), () => reject(new Error(error)));
          } else void rename(job.tempPath, path).then(resolve, () => {
            void rm(job.tempPath, { force: true }); reject(new Error('The voice recording could not be saved.'));
          });
        },
      };
      const cancel = () => job.finish('Voice cancelled.');
      const timer = setTimeout(() => job.finish('Codex could not finish the reading in time.'), voiceCodexMs);
      const offExit = callCodex.onExit(() => job.finish('Codex voice disconnected.'));
      const off = callCodex.onNotification((method, value) => {
        const p = value as { threadId?: string; role?: string; text?: string; message?: string; turn?: { id: string } };
        if (!job.thread || p.threadId !== job.thread) return;
        if (method === 'thread/realtime/error' || method === 'thread/realtime/closed') return job.finish('Codex voice disconnected before the reading was ready.');
        if (method === 'turn/started' && p.turn) {
          void callCodex.request('turn/interrupt', { threadId: job.thread, turnId: p.turn.id }).catch(() => {});
          return job.finish('Codex did not stay in reading mode.');
        }
        if (method !== 'thread/realtime/transcript/done' || p.role !== 'assistant' || !p.text) return;
        job.transcript = `${job.transcript} ${p.text}`.trim();
        const progress = readingProgress(script, job.transcript);
        if (progress === 'mismatch') return job.finish('Codex did not read the requested text.');
        job.complete = progress === 'complete';
        if (job.complete && job.uploaded) job.finish();
      });
      signal.addEventListener('abort', cancel, { once: true });
      this.jobs.set(id, job);
      this.send(job, { type: 'voice-audio', id, state: 'start', script, voice, token: job.token, timeoutMs: voiceCodexMs, maxBytes: voiceAudioBytes, tailMs: voiceTailMs });
    });
  }

  async offer(owner: WebSocket, id: string, sdp: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || job.offering) return;
    job.offering = true;
    try {
      await mkdir(WORK, { recursive: true });
      const { config } = await callCodex.request('config/read', { cwd: WORK });
      if (!this.jobs.has(id)) return;
      const mcpOff = Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false]));
      const { thread } = await callCodex.request('thread/start', {
        cwd: WORK, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: 'Read the requested text only. Do not use tools.', developerInstructions: 'Do not use tools, read files or delegate.',
        config: { ...mcpOff, 'features.multi_agent': false, 'features.shell_tool': false, 'features.apps': false, 'features.hooks': false, 'features.memories': false },
      });
      job.thread = thread.id;
      if (!this.jobs.has(id)) return void callCodex.request('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
      const answer = new Promise<string>((resolve, reject) => {
        const abort = () => { off(); job.signal.removeEventListener('abort', abort); reject(new Error('Voice cancelled.')); };
        job.cancelAnswer = abort;
        const off = callCodex.onNotification((method, value) => {
          const p = value as { threadId?: string; sdp?: string };
          if (method === 'thread/realtime/sdp' && p.threadId === thread.id && p.sdp) {
            off(); job.cancelAnswer = undefined; job.signal.removeEventListener('abort', abort); resolve(p.sdp);
          }
        });
        job.signal.addEventListener('abort', abort, { once: true });
      });
      job.starting = callCodex.request('thread/realtime/start', {
        threadId: thread.id, outputModality: 'audio', transport: { type: 'webrtc', sdp }, version: 'v3',
        prompt: INSTRUCTIONS, includeStartupContext: false, clientManagedHandoffs: true, flushTranscriptTailOnSessionEnd: false,
        ...(job.voice ? { voice: job.voice } : {}),
      }, tuning().callSdpMs);
      const [, remote] = await Promise.all([job.starting, answer]);
      if (this.jobs.has(id)) this.send(job, { type: 'voice-audio', id, state: 'answer', sdp: remote });
    } catch {
      job.finish('Codex voice could not connect.');
    }
  }

  async ready(owner: WebSocket, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || !job.thread || job.spoken) return;
    job.spoken = true;
    try {
      await callCodex.request('thread/realtime/appendText', { threadId: job.thread, role: 'user', text: `Read the following text aloud exactly, then stop:\n${job.script}` });
    } catch { job.finish('Codex could not accept the reading request.'); }
  }

  fail(owner: WebSocket, id: string) {
    const job = this.jobs.get(id);
    if (job?.owner === owner) job.finish('Codex voice could not record the reading in this window.');
  }

  drop(owner: WebSocket) {
    this.native.delete(owner);
    for (const j of this.jobs.values()) if (j.owner === owner) j.finish('The voice window disconnected.');
  }

  close() {
    for (const j of this.jobs.values()) j.finish('Voice stopped.');
  }

  async serve(req: IncomingMessage, res: ServerResponse, origins: Set<string>): Promise<boolean> {
    const match = /^\/files\/voice-capture\/([\w-]{36})$/.exec(req.url ?? '');
    if (!match) return false;
    const job = this.jobs.get(match[1]);
    if (req.method !== 'POST' || !origins.has(req.headers.origin ?? '') || !job || job.owner.readyState !== 1 || req.headers['x-voice-token'] !== job.token) {
      res.writeHead(403).end(); return true;
    }
    try {
      if (req.headers['content-type'] !== 'audio/wav' || job.uploaded) throw new Error('Invalid audio upload.');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const b of req) {
        bytes += b.length;
        if (bytes > tuning().voiceAudioBytes) throw new Error('Voice recording is too large.');
        chunks.push(Buffer.from(b));
      }
      const wav = Buffer.concat(chunks);
      if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 16) !== 'WAVEfmt '
        || wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1
        || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 48000 || wav.readUInt32LE(28) !== 96000 || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16
        || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44 || wav.length % 2) throw new Error('The voice recording is not a complete WAV.');
      let audible = false;
      for (let i = 44; i < wav.length; i += 2) if (wav.readInt16LE(i) !== 0) { audible = true; break; }
      if (!audible) throw new Error('The voice recording is empty.');
      if (this.jobs.get(job.id) !== job || job.signal.aborted) throw new Error('Voice cancelled.');
      await mkdir(join(job.path, '..'), { recursive: true });
      await writeFile(job.tempPath, wav);
      if (this.jobs.get(job.id) !== job || job.signal.aborted) { await rm(job.tempPath, { force: true }); throw new Error('Voice cancelled.'); }
      job.uploaded = true;
      res.writeHead(200).end();
      if (job.complete) job.finish();
    } catch {
      res.writeHead(400).end();
      job.finish('Codex voice did not produce a complete recording.');
    }
    return true;
  }
}

export const codexVoice = new CodexVoice();
