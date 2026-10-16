import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { ask } from './titles.ts';
import type { VoiceClip } from './protocol.ts';
import { CACHE_DIR, config, t } from './config.ts';
import { fullText } from './stretch.ts';

const KOKORO = join(homedir(), '.local/share/kokoro-tts');
const PYTHON = join(KOKORO, 'venv/bin/python');
// Kokoro is an optional install; without it voice recaps stay off and the client hides the switch.
const KOKORO_FILES = [PYTHON, join(KOKORO, 'kokoro-v1.0.onnx'), join(KOKORO, 'voices-v1.0.bin')];
const RENDER = fileURLToPath(new URL('./voice.py', import.meta.url));
const VOICE = config.voice.name;
const SPEED = config.voice.speed;
const RENDER_MS = 120_000;
// Ready clips kept per session so a replay needs no new render.
const MAX_CLIPS = 6;
// espeak language Kokoro phonemizes with.
const LANG = t({ en: 'en-us', 'pt-BR': 'pt-br' });
const DIR = process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, 'tarcsweb-voice') : join(CACHE_DIR, 'voice');
const CONFIG = join(CACHE_DIR, 'voice.json');

const RECAP_EN = `You are a developer who works alongside the user. You just finished a piece of work and will say out loud what was done, like a colleague chatting, in English.

The user asked to hear this, so always speak. If work was done, tell what was done. If it was an explanation or a plain answer, give its gist.

Return only the text to be read, no markdown, up to 110 words:
- Informal tone, first person plural: "we did", "here's how it ended up", "the thing is".
- Start straight with the result. Vary the opening; do not always start with "So" or "Alright".
- Tell what changed and how it works now. Say if something is still pending or if there is a risk.
- Short sentences. Punctuate so the voice pauses: comma for a short pause, period for a long one.
- Never read a file path, code, a full command or a URL. Say "the register file", "a command", "a link".
- Symbols become words. A technical name that would sound odd read aloud, write it the way a person says it, like "jay-son" for JSON and "engine x" for nginx.
- Ignore the "I can go deeper on" line and offers to go deeper.`;

const RECAP_PT = `Você é um desenvolvedor que trabalha junto com o usuário. Você acabou de terminar um trabalho e vai contar em voz alta o que foi feito, como um colega conversando, em português do Brasil.

O usuário pediu para ouvir isto, então sempre fale. Se houve trabalho, conte o que foi feito. Se foi uma explicação ou uma resposta simples, conte a ideia principal.

Devolva só o texto a ser lido, sem markdown, até 110 palavras:
- Tom informal, primeira pessoa do plural: "a gente fez", "ficou assim", "o lance é que".
- Comece direto pelo resultado. Varie a abertura; não comece sempre com "Então" ou "E aí".
- Conte o que mudou e como funciona agora. Diga se algo ficou pendente ou se tem risco.
- Frases curtas. Pontue para a voz pausar: vírgula para pausa curta, ponto para pausa longa.
- Nunca leia caminho de arquivo, código, comando completo ou URL. Diga "o arquivo register", "um comando", "um link".
- Símbolos viram palavras. Nome técnico em inglês que soaria estranho, escreva como um brasileiro pronuncia, como "rúk" para hook e "deplói" para deploy.
- Ignore a linha "I can go deeper on" e ofertas de aprofundar.`;

const RECAP = t({ en: RECAP_EN, 'pt-BR': RECAP_PT });
const RECAP_INPUT = t({ en: { prompt: 'User request', answer: "Agent's final answer" }, 'pt-BR': { prompt: 'Pedido do usuário', answer: 'Resposta final do agente' } });

const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
// Code blocks and the hints line are not reading effort.
export const proseWords = (text: string) => countWords(text.replace(/```[\s\S]*?```/g, ' ').replace(/^I can go deeper on:.*$/gm, ' '));

type Clip = { sessionId: string; reply: string; path: string; script: string };

// Spoken recaps on request: Haiku writes the script, Kokoro renders one WAV per reply, served by an unguessable id.
export class Voice {
  // null when Kokoro is not installed.
  on: boolean | null = true;
  private clips = new Map<string, Clip>();
  // The newest recap being made per session; an older one that finishes later is thrown away.
  private latest = new Map<string, { id: string; reply: string }>();
  private listeners = new Set<(m: VoiceClip | { type: 'voice-on'; on: boolean | null }) => void>();
  // One render at a time: Kokoro takes every core.
  private chain: Promise<void> = Promise.resolve();
  private child: ChildProcess | null = null;
  private asking = new Set<Query>();

  constructor() {
    const missing = KOKORO_FILES.find((f) => !existsSync(f));
    if (missing) {
      this.on = null;
      console.log(`voice recaps off: ${missing} is missing (run install.sh to add Kokoro)`);
      return;
    }
    try {
      this.on = JSON.parse(readFileSync(CONFIG, 'utf8')).on !== false;
    } catch {}
  }

  subscribe(fn: (m: VoiceClip | { type: 'voice-on'; on: boolean | null }) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(m: VoiceClip | { type: 'voice-on'; on: boolean | null }) {
    for (const fn of this.listeners) fn(m);
  }

  setOn(on: boolean) {
    if (this.on === null) return;
    this.on = on;
    try {
      mkdirSync(join(CONFIG, '..'), { recursive: true });
      writeFileSync(CONFIG, JSON.stringify({ on }));
    } catch {}
    if (!on) for (const [sessionId, job] of this.latest) this.drop(sessionId, job.id, job.reply);
    this.emit({ type: 'voice-on', on });
  }

  // The Listen button on one reply; never awaited. A reply already being made is ignored, a finished one gets a fresh id on the same file.
  request(sessionId: string, reply: string, prompt: string, raw: string) {
    if (!this.on || this.latest.get(sessionId)?.reply === reply) return;
    const id = randomUUID();
    const done = [...this.clips.values()].find((c) => c.sessionId === sessionId && c.reply === reply);
    if (done) {
      this.clips.set(id, done);
      this.trim(sessionId);
      this.emit({ type: 'voice', sessionId, id, reply, state: 'ready', url: `/files/voice/${id}.wav`, text: done.script, words: countWords(done.script) });
      return;
    }
    this.latest.set(sessionId, { id, reply });
    this.emit({ type: 'voice', sessionId, id, reply, state: 'preparing', url: null, text: '', words: 0 });
    void this.make(sessionId, id, reply, prompt, fullText(raw)).catch((err) => {
      console.error(`voice recap failed: ${err instanceof Error ? err.message : String(err)}`);
      this.drop(sessionId, id, reply);
    });
  }

  private async make(sessionId: string, id: string, reply: string, prompt: string, answer: string) {
    const started = Date.now();
    let q: Query | null = null;
    const once = () => ask(
      `${RECAP_INPUT.prompt}:\n${prompt.slice(-1500)}\n\n${RECAP_INPUT.answer}:\n${answer.slice(0, 6000)}`,
      (next) => {
        if (q) this.asking.delete(q);
        q = next;
        if (q) this.asking.add(q);
      },
      RECAP,
      { effort: 'low', maxTokens: 1000 },
    );
    // A failed call gets one retry.
    const said = (await once()) ?? (this.current(sessionId, id) ? await once() : null);
    const script = (said ?? '').replace(/\s+/g, ' ').trim();
    if (!this.current(sessionId, id)) return this.drop(sessionId, id, reply);
    if (!script) {
      console.error(`voice recap failed: Haiku returned nothing after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return this.drop(sessionId, id, reply);
    }
    const path = join(DIR, sessionId, `${id}.wav`);
    const run = this.chain.then(() => (this.current(sessionId, id) ? this.render(script, path) : false));
    this.chain = run.then(() => undefined, () => undefined);
    if (!(await run) || !this.current(sessionId, id)) {
      await rm(path, { force: true });
      return this.drop(sessionId, id, reply);
    }
    this.latest.delete(sessionId);
    this.clips.set(id, { sessionId, reply, path, script });
    this.trim(sessionId);
    console.log(`voice recap ready in ${((Date.now() - started) / 1000).toFixed(1)}s (${countWords(script)} words)`);
    this.emit({ type: 'voice', sessionId, id, reply, state: 'ready', url: `/files/voice/${id}.wav`, text: script, words: countWords(script) });
  }

  private current(sessionId: string, id: string) {
    return this.on && this.latest.get(sessionId)?.id === id;
  }

  // Evicts the session's oldest clips past the cap.
  private trim(sessionId: string) {
    const mine = [...this.clips].filter(([, c]) => c.sessionId === sessionId);
    for (const [id, c] of mine.slice(0, Math.max(0, mine.length - MAX_CLIPS))) {
      this.forget(id);
      this.emit({ type: 'voice', sessionId, id, reply: c.reply, state: 'dropped', url: null, text: '', words: 0 });
    }
  }

  private render(text: string, path: string) {
    mkdirSync(join(path, '..'), { recursive: true });
    return new Promise<boolean>((resolve) => {
      // Low priority, so the UI and the agent stay responsive while it renders.
      const child = spawn('nice', ['-n', '10', PYTHON, RENDER, path, VOICE, String(SPEED), LANG], { stdio: ['pipe', 'ignore', 'pipe'] });
      this.child = child;
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), RENDER_MS);
      child.stderr!.on('data', (d) => (err = (err + d).slice(-2000)));
      child.on('error', () => {});
      child.on('close', (code) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (code !== 0) console.error(`voice render exited ${code}: ${err.split('\n').filter((l) => l && !/warn/i.test(l)).slice(-3).join(' | ')}`);
        resolve(code === 0);
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(text);
    });
  }

  private drop(sessionId: string, id: string, reply: string) {
    if (this.latest.get(sessionId)?.id === id) this.latest.delete(sessionId);
    this.emit({ type: 'voice', sessionId, id, reply, state: 'dropped', url: null, text: '', words: 0 });
  }

  // A replayed reply shares its Clip with the first id; the file goes with the last one.
  private forget(id: string) {
    const c = this.clips.get(id);
    if (!c) return;
    this.clips.delete(id);
    if (![...this.clips.values()].includes(c)) void rm(c.path, { force: true });
  }

  // The session closed: its clips and folder go.
  clear(sessionId: string) {
    const job = this.latest.get(sessionId);
    if (job) this.drop(sessionId, job.id, job.reply);
    for (const [cid, c] of this.clips) if (c.sessionId === sessionId) {
      this.clips.delete(cid);
      this.emit({ type: 'voice', sessionId, id: cid, reply: c.reply, state: 'dropped', url: null, text: '', words: 0 });
    }
    void rm(join(DIR, sessionId), { recursive: true, force: true });
  }

  close() {
    for (const q of this.asking) q.close();
    this.child?.kill('SIGKILL');
    for (const id of [...this.clips.keys()]) this.forget(id);
  }

  // GET /files/voice/<id>.wav, with byte ranges so the player can seek; false when the URL is not ours.
  async serve(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const m = /^\/files\/voice\/([\w-]{36})\.wav$/.exec(new URL(req.url ?? '/', 'http://local').pathname);
    if (!m) return false;
    const clip = this.clips.get(m[1]);
    if (!clip || (req.method !== 'GET' && req.method !== 'HEAD')) return void res.writeHead(clip ? 405 : 404).end(), true;
    let size: number;
    try {
      size = (await stat(clip.path)).size;
    } catch {
      return void res.writeHead(404).end(), true;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return void res.writeHead(416, { 'content-range': `bytes */${size}` }).end(), true;
    }
    const partial = start > 0 || end < size - 1;
    res.writeHead(partial ? 206 : 200, {
      'content-type': 'audio/wav', 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return res.end(), true;
    createReadStream(clip.path, { start, end }).on('error', () => res.destroy()).pipe(res);
    return true;
  }
}
