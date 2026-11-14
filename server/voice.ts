import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ask, type Asking } from './titles.ts';
import type { CallVoice, Provider, ReplayVoice, VoiceClip } from './protocol.ts';
import { CACHE_DIR, config, t } from './config.ts';
import { fullText } from './stretch.ts';
import { tuning } from './profile.ts';
import type { WebSocket } from 'ws';
import { codexVoice } from './voiceCodex.ts';
import { readingChunks } from './voiceText.ts';

const KOKORO = join(homedir(), '.local/share/kokoro-tts');
const PYTHON = join(KOKORO, 'venv/bin/python');
// Kokoro is optional; availability must not overwrite the saved Listen preference.
const KOKORO_FILES = [PYTHON, join(KOKORO, 'kokoro-v1.0.onnx'), join(KOKORO, 'voices-v1.0.bin')];
const RENDER = fileURLToPath(new URL('./voice.py', import.meta.url));
const SPEED = config.voice.speed;
const RENDER_MS = 120_000;
// Ready clips kept per session so a replay needs no new render.
const MAX_CLIPS = 6;
const MAX_PREVIEWS = 12;
const DIR = process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, 'tarcsweb-voice') : join(CACHE_DIR, 'voice');
const CONFIG = join(CACHE_DIR, 'voice.json');
// The sound robot keeps the voice of its prerecorded lines in web/public/sounds, whatever the recap voice is.
const ROBOT = { voice: 'af_heart', speed: '1.05', lang: 'en-us' };
type RobotMode = 'robot' | 'robot-g';
// Robot lines kept by text: names repeat, so most play without a new render.
const MAX_LINES = 40;
const LINE_CHARS = 80;
// On disk, unlike the clips: a restart keeps them. Bump the version when voice.py's robot treatment changes.
const LINES_DIR = join(CACHE_DIR, 'voice-lines');
const LINES_VERSION = 1;
const LINES_DISK_MAX = 400;

// Keeps the newest lines on disk; a hit refreshes a file's mtime, so the least recently played go first.
async function pruneLines() {
  const names = (await readdir(LINES_DIR).catch(() => [])).filter((n) => n.endsWith('.wav'));
  if (names.length <= LINES_DISK_MAX) return;
  const aged = await Promise.all(names.map(async (n) => ({ n, at: (await stat(join(LINES_DIR, n)).catch(() => null))?.mtimeMs ?? 0 })));
  aged.sort((a, b) => a.at - b.at);
  for (const { n } of aged.slice(0, aged.length - LINES_DISK_MAX)) await rm(join(LINES_DIR, n), { force: true });
}

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

const RECAP_INPUT = t({ en: { prompt: 'User request', answer: "Agent's final answer" }, 'pt-BR': { prompt: 'Pedido do usuário', answer: 'Resposta final do agente' } });

const NARRATE_EN = `You are a patient teacher. The listener just opened a replay: a short series of visual pages that explains something. You will record one spoken summary of the whole replay for them, in English.

Your goal is that the listener really understands what the replay shows and why it matters, even if they are tired or new to the subject. Talk to them directly, as "you". Never assume they already know a term.

Return only the text to be read aloud, about 180 to 300 words:
- Start with one sentence that says what the replay is about.
- Then walk through what it shows, in the order of the pages. Link each part to the one before, so it sounds like one story, not a list.
- Short sentences, one idea each. Everyday words.
- The first time a technical term comes up, say what it means in plain words.
- When something is abstract, give one everyday example that makes it concrete. One example in total, not one per idea.
- Say why it matters: what it changes for the listener, or what problem it solves.
- End with the one thing to remember, in one sentence.
- Spoken text only: no markdown, lists, headings, code or emoji. Never read a file path, a URL, code or a full command; say "the settings file", "a link", "a command".
- Symbols become words. A technical name that would sound odd read aloud, write it the way a person says it, like "jay-son" for JSON and "engine x" for nginx.
- Punctuate so the voice pauses: comma for a short pause, period for a long one.
- Do not read page numbers or page titles as labels. Do not add facts the pages do not show.`;

const NARRATE_PT = `Você é um professor paciente. A pessoa acabou de abrir um replay: uma sequência curta de páginas visuais que explica alguma coisa. Você vai gravar um único resumo falado do replay inteiro para ela, em português do Brasil.

Seu objetivo é que a pessoa entenda de verdade o que o replay mostra e por que isso importa, mesmo cansada ou nova no assunto. Fale direto com ela, de "você". Nunca suponha que ela já conhece um termo.

Devolva só o texto a ser lido em voz alta, entre 180 e 300 palavras:
- Comece com uma frase que diz do que o replay trata.
- Depois percorra o que ele mostra, na ordem das páginas. Ligue cada parte à anterior, para soar como uma história, não uma lista.
- Frases curtas, uma ideia cada. Palavras do dia a dia.
- Na primeira vez que aparecer um termo técnico, diga o que ele significa em palavras simples.
- Quando algo for abstrato, dê um exemplo do cotidiano que torne aquilo concreto. Um exemplo no total, não um por ideia.
- Diga por que isso importa: o que muda para a pessoa, ou que problema resolve.
- Termine com a única coisa para lembrar, em uma frase.
- Só texto falado: sem markdown, listas, títulos, código ou emoji. Nunca leia caminho de arquivo, URL, código ou comando completo; diga "o arquivo de configuração", "um link", "um comando".
- Símbolos viram palavras. Nome técnico em inglês que soaria estranho, escreva como um brasileiro pronuncia, como "rúk" para hook e "deplói" para deploy.
- Pontue para a voz pausar: vírgula para pausa curta, ponto para pausa longa.
- Não leia número nem título de página como rótulo. Não acrescente fatos que as páginas não mostram.`;

const NARRATE_INPUT = t({ en: { title: 'Replay title', page: 'Page' }, 'pt-BR': { title: 'Título do replay', page: 'Página' } });
// Explanation quality matters more than speed here, so the script comes from Sonnet.
const NARRATE_MODEL = 'claude-sonnet-5-5';
const NARRATE_MS = 120_000;
// Replay summaries kept per session, so reopening a replay plays at once.
const MAX_NARRATIONS = 4;

type ReplayText = { title: string; pages: { title: string; text: string }[] };
type Narration = { sessionId: string; replay: string; id: string; path: string; script: string; renderer: 'kokoro' | 'codex' };
// A narration failure whose message is fit to show in the viewer.
class Spoken extends Error {}
type VoiceEvent = VoiceClip | ReplayVoice | { type: 'voice-on'; on: boolean; available: boolean } | { type: 'notice'; message: string };
const LITE_ERROR = 'Voice recaps are disabled in Lite mode. Switch to Standard to listen.';
const UNAVAILABLE_ERROR = 'Voice is not installed. Run ./install.sh and enable voice to listen.';
const voiceAsk: typeof ask = (...args) => {
  if (!tuning().voiceRecaps) throw new Spoken(LITE_ERROR);
  return ask(...args);
};

const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
// Code blocks and the hints line are not reading effort.
export const proseWords = (text: string) => countWords(text.replace(/```[\s\S]*?```/g, ' ').replace(/^I can go deeper on:.*$/gm, ' '));

type Clip = { sessionId: string; reply: string; path: string; script: string; identity: string; renderer: 'kokoro' | 'codex' };
type RenderChoice = { renderer: 'kokoro' | 'codex'; voice: string | null; language: 'en' | 'pt-BR' };
type Job = { owner?: WebSocket; abort: AbortController };

// Read a summary or the supplied text into one WAV per reply, served by an unguessable id.
export class Voice {
  on = true;
  readonly available: boolean;
  private clips = new Map<string, Clip>();
  // The newest recap being made per session; an older one that finishes later is thrown away.
  private latest = new Map<string, Job & { id: string; reply: string }>();
  private listeners = new Set<(m: VoiceEvent) => void>();
  // Replay summaries by "sessionId:replayId:language", ready or being made; capped per session by MAX_NARRATIONS.
  private narrations = new Map<string, Narration>();
  private narrating = new Map<string, ReplayVoice>();
  private narrationJobs = new Map<string, Job>();
  // Robot lines by "g:" or "p:" (glitched or plain) plus text; capped by MAX_LINES.
  private lines = new Map<string, { id: string; path: string; ready: Promise<boolean> }>();
  // Voice/language clips capped by MAX_PREVIEWS; one active request per connected window.
  private previews = new Map<string, { id: string; path: string }>();
  private previewJobs = new Map<WebSocket, Job & { id: string }>();
  // One render at a time: Kokoro takes every core.
  private chain: Promise<void> = Promise.resolve();
  private child: ChildProcess | null = null;
  private asking = new Set<Asking>();

  constructor() {
    const missing = KOKORO_FILES.find((f) => !existsSync(f));
    this.available = !missing;
    if (missing) {
      console.log(`voice recaps off: ${missing} is missing (run install.sh to add Kokoro)`);
    }
    try {
      this.on = JSON.parse(readFileSync(CONFIG, 'utf8')).on !== false;
    } catch {}
  }

  subscribe(fn: (m: VoiceEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  availableFor(owner: WebSocket) {
    return this.available || config.recapRenderer === 'codex' && codexVoice.usable(owner);
  }

  private emit(m: VoiceEvent) {
    for (const fn of this.listeners) fn(m);
  }

  setOn(on: boolean) {
    this.on = on;
    try {
      mkdirSync(join(CONFIG, '..'), { recursive: true });
      writeFileSync(CONFIG, JSON.stringify({ on }));
    } catch {}
    if (!on) for (const [sessionId, job] of this.latest) this.drop(sessionId, job.id, job.reply);
    this.emit({ type: 'voice-on', on, available: this.available });
  }

  // The Listen button on one reply; never awaited. A reply already being made is ignored, a finished one gets a fresh id on the same file.
  request(sessionId: string, reply: string, prompt: string, raw: string, provider: Provider, owner?: WebSocket, mode: 'summary' | 'verbatim' = 'summary') {
    if (!tuning().voiceRecaps) return this.emit({ type: 'notice', message: LITE_ERROR });
    if (!this.on || this.latest.get(sessionId)?.reply === reply) return;
    if (!this.available && config.recapRenderer !== 'codex') return this.emit({ type: 'notice', message: UNAVAILABLE_ERROR });
    const id = randomUUID();
    const choice: RenderChoice = { renderer: config.recapRenderer, voice: config.recapRenderer === 'codex' ? config.recapVoice : config.voice.name, language: config.language };
    const identity = JSON.stringify([choice, mode, createHash('sha256').update(`${prompt}\n${raw}`).digest('hex')]);
    const done = [...this.clips.values()].find((c) => c.sessionId === sessionId && c.reply === reply && c.identity === identity && c.renderer === choice.renderer);
    if (done) {
      this.clips.set(id, done);
      this.trim(sessionId);
      this.emit({ type: 'voice', sessionId, id, reply, state: 'ready', url: `/files/voice/${id}.wav`, text: done.script, words: countWords(done.script) });
      return;
    }
    const previous = this.latest.get(sessionId);
    if (previous) this.drop(sessionId, previous.id, previous.reply);
    const job = { id, reply, owner, abort: new AbortController() };
    this.latest.set(sessionId, job);
    this.emit({ type: 'voice', sessionId, id, reply, state: 'preparing', url: null, text: '', words: 0 });
    void this.make(sessionId, id, reply, prompt, mode === 'verbatim' ? raw : fullText(raw), provider, choice, identity, job, mode).catch((err) => {
      console.error(`voice recap failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!job.abort.signal.aborted) this.emit({ type: 'notice', message: err instanceof Spoken ? err.message : 'The voice recap failed.' });
      this.drop(sessionId, id, reply);
    });
  }

  private async make(sessionId: string, id: string, reply: string, prompt: string, answer: string, provider: Provider, choice: RenderChoice, identity: string, job: Job, mode: 'summary' | 'verbatim') {
    const started = Date.now();
    let q: Asking | null = null;
    job.abort.signal.addEventListener('abort', () => q?.close(), { once: true });
    const once = () => voiceAsk(
      `${RECAP_INPUT.prompt}:\n${prompt.slice(-1500)}\n\n${RECAP_INPUT.answer}:\n${answer.slice(0, 6000)}`,
      (next) => {
        if (q) this.asking.delete(q);
        q = next;
        if (q) this.asking.add(q);
        if (job.abort.signal.aborted) q?.close();
      },
      choice.language === 'pt-BR' ? RECAP_PT : RECAP_EN,
      { effort: 'low', maxTokens: 1000, provider },
    );
    // A failed call gets one retry.
    const said = mode === 'verbatim' ? answer : (await once()) ?? (this.current(sessionId, id) ? await once() : null);
    const script = mode === 'verbatim' ? (said ?? '').trim() : (said ?? '').replace(/\s+/g, ' ').trim();
    if (!this.current(sessionId, id)) return this.drop(sessionId, id, reply);
    if (!script) {
      console.error(`voice reading has no text after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return this.drop(sessionId, id, reply);
    }
    const path = join(DIR, sessionId, `${id}.wav`);
    const renderer = await this.queueRecap(script, path, () => this.current(sessionId, id), choice, job);
    if (!renderer || !this.current(sessionId, id)) {
      await rm(path, { force: true });
      return this.drop(sessionId, id, reply);
    }
    this.latest.delete(sessionId);
    this.clips.set(id, { sessionId, reply, path, script, identity, renderer });
    this.trim(sessionId);
    console.log(`voice recap ready in ${((Date.now() - started) / 1000).toFixed(1)}s (${countWords(script)} words)`);
    this.emit({ type: 'voice', sessionId, id, reply, state: 'ready', url: `/files/voice/${id}.wav`, text: script, words: countWords(script) });
  }

  preview(owner: WebSocket, id: string, voice: CallVoice | null) {
    const previous = this.previewJobs.get(owner);
    if (previous) this.cancelPreview(owner, previous.id);
    const send = (state: 'preparing' | 'ready' | 'failed', extra: { url?: string; error?: string } = {}) => {
      if (owner.readyState === 1) owner.send(JSON.stringify({ type: 'voice-preview', id, state, ...extra }));
    };
    if (!tuning().voiceRecaps) return send('failed', { error: LITE_ERROR });
    if (!codexVoice.usable(owner)) return send('failed', { error: 'Codex voice is unavailable in this window.' });
    const language = config.language;
    const key = JSON.stringify([voice, language]);
    const cached = this.previews.get(key);
    if (cached) {
      this.previews.delete(key); this.previews.set(key, cached);
      return send('ready', { url: `/files/voice/${cached.id}.wav` });
    }
    const job = { id, owner, abort: new AbortController() };
    this.previewJobs.set(owner, job);
    const alive = () => this.previewJobs.get(owner) === job && !job.abort.signal.aborted;
    const clip = { id: randomUUID(), path: '' };
    clip.path = join(DIR, 'previews', `${clip.id}.wav`);
    const script = language === 'pt-BR'
      ? 'Esta é uma amostra da voz lendo uma frase em português.'
      : 'This is a sample of the voice reading a sentence in English.';
    send('preparing');
    const run = this.chain.then(async () => {
      if (!alive()) return;
      if (!tuning().voiceRecaps) throw new Spoken(LITE_ERROR);
      await codexVoice.render(script, clip.path, owner, job.abort.signal, voice);
      if (!alive()) return;
      const old = this.previews.get(key);
      if (old) void rm(old.path, { force: true });
      this.previews.delete(key); this.previews.set(key, clip);
      for (const [k, value] of [...this.previews].slice(0, Math.max(0, this.previews.size - MAX_PREVIEWS))) {
        this.previews.delete(k); void rm(value.path, { force: true });
      }
      send('ready', { url: `/files/voice/${clip.id}.wav` });
    });
    this.chain = run.then(() => undefined, () => undefined);
    void run.catch((error: unknown) => {
      if (alive()) send('failed', { error: error instanceof Error ? error.message : 'The voice preview failed.' });
    }).finally(() => {
      if (this.previewJobs.get(owner) === job) this.previewJobs.delete(owner);
      if (this.previews.get(key) !== clip) void rm(clip.path, { force: true });
    });
  }

  cancelPreview(owner: WebSocket, id: string) {
    const job = this.previewJobs.get(owner);
    if (job?.id !== id) return;
    job.abort.abort(); this.previewJobs.delete(owner);
  }

  // The replay viewer's Listen button: one summary per replay, made once; a click while it is being made only re-sends its state.
  narrate(sessionId: string, replay: string, load: () => Promise<ReplayText | null>, provider: Provider, owner?: WebSocket) {
    const choice: RenderChoice = { renderer: config.recapRenderer, voice: config.recapRenderer === 'codex' ? config.recapVoice : config.voice.name, language: config.language };
    const key = `${sessionId}:${replay}:${JSON.stringify(choice)}`;
    const base = { type: 'replay-voice', sessionId, id: replay, step: null, url: null, text: '', words: 0, error: null } as const;
    if (!tuning().voiceRecaps) return this.emit({ ...base, state: 'failed', error: LITE_ERROR });
    if (!this.available && choice.renderer !== 'codex') return this.emit({ ...base, state: 'failed', error: UNAVAILABLE_ERROR });
    const busy = this.narrating.get(key);
    if (busy) return this.emit(busy);
    const job: Job = { owner, abort: new AbortController() };
    this.narrationJobs.set(key, job);
    const mine = [...this.narrationJobs.keys()].filter((k) => k.startsWith(`${sessionId}:`));
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_NARRATIONS))) {
      this.narrationJobs.get(old)?.abort.abort(); this.narrationJobs.delete(old);
      const m = this.narrating.get(old); this.narrating.delete(old);
      if (m) this.emit({ ...m, state: 'dropped', step: null });
    }
    const step = (s: 'script' | 'audio') => {
      const m: ReplayVoice = { ...base, state: 'preparing', step: s };
      this.narrating.set(key, m);
      this.emit(m);
    };
    step('script');
    void this.makeNarration(key, sessionId, replay, load, step, provider, choice, job).then(
      (n) => {
        if (!n) return;
        this.emit({ ...base, state: 'ready', url: `/files/voice/${n.id}.wav`, text: n.script, words: countWords(n.script) });
        this.trimNarrations(sessionId);
      },
      (err: unknown) => {
        if (this.narrationJobs.get(key) !== job) return;
        this.narrationJobs.delete(key);
        console.error(`replay summary failed: ${err instanceof Error ? err.message : String(err)}`);
        if (this.narrating.delete(key)) this.emit({ ...base, state: 'failed', error: err instanceof Spoken ? err.message : 'The summary failed' });
      },
    );
  }

  // Thrown messages are shown to the user as is.
  private async makeNarration(key: string, sessionId: string, replay: string, load: () => Promise<ReplayText | null>, step: (s: 'audio') => void, provider: Provider, choice: RenderChoice, job: Job) {
    const started = Date.now();
    const alive = () => this.narrationJobs.get(key) === job && !job.abort.signal.aborted;
    const input = await load();
    if (!alive()) return null;
    if (!input?.pages.some((p) => p.text)) throw new Spoken('The replay pages have no text to summarise');
    const cacheKey = `${key}:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
    const cached = this.narrations.get(cacheKey);
    if (cached?.renderer === choice.renderer) {
      this.narrating.delete(key); this.narrationJobs.delete(key);
      return cached;
    }
    const body = input.pages.map((p, i) => `${NARRATE_INPUT.page} ${i + 1}/${input.pages.length}: ${p.title}\n${p.text}`).join('\n\n');
    let q: Asking | null = null;
    job.abort.signal.addEventListener('abort', () => q?.close(), { once: true });
    const once = () => voiceAsk(
      `${NARRATE_INPUT.title}: ${input.title}\n\n${body}`,
      (next) => {
        if (q) this.asking.delete(q);
        q = next;
        if (q) this.asking.add(q);
        if (job.abort.signal.aborted) q?.close();
      },
      choice.language === 'pt-BR' ? NARRATE_PT : NARRATE_EN,
      { model: NARRATE_MODEL, maxTokens: 2000, timeoutMs: NARRATE_MS, provider },
    );
    const said = (await once()) ?? (alive() ? await once() : null);
    if (!alive()) return null;
    const script = (said ?? '').replace(/\s+/g, ' ').trim();
    if (!script) throw new Spoken('The summary could not be written');
    step('audio');
    const id = randomUUID();
    const path = join(DIR, sessionId, `replay-${id}.wav`);
    const renderer = await this.queueRecap(script, path, alive, choice, job);
    if (!renderer || !alive()) {
      await rm(path, { force: true });
      if (!alive()) return null;
      throw new Spoken('The voice could not be recorded');
    }
    this.narrating.delete(key);
    this.narrationJobs.delete(key);
    const n: Narration = { sessionId, replay, id, path, script, renderer };
    if (cached) void rm(cached.path, { force: true });
    this.narrations.set(cacheKey, n);
    console.log(`replay summary ready in ${((Date.now() - started) / 1000).toFixed(1)}s (${countWords(script)} words)`);
    return n;
  }

  // Evicts the session's oldest replay summaries past the cap.
  private trimNarrations(sessionId: string) {
    const mine = [...this.narrations].filter(([, n]) => n.sessionId === sessionId);
    for (const [key, n] of mine.slice(0, Math.max(0, mine.length - MAX_NARRATIONS))) {
      this.narrations.delete(key);
      void rm(n.path, { force: true });
      this.emit({ type: 'replay-voice', sessionId, id: n.replay, state: 'dropped', step: null, url: null, text: '', words: 0, error: null });
    }
  }

  // A short robot line for the sound engine; its url, or null without Kokoro, in Lite or when the render fails.
  async say(text: string, glitch: boolean): Promise<string | null> {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS);
    if (!clean || !this.available || !tuning().voiceRecaps) return null;
    const key = `${glitch ? 'g' : 'p'}:${clean}`;
    let line = this.lines.get(key);
    if (!line) {
      // Named by its text and voice, so a line rendered before a restart plays without starting Kokoro.
      const id = createHash('sha256').update(`${LINES_VERSION}|${ROBOT.voice}|${ROBOT.speed}|${key}`).digest('hex').slice(0, 36);
      const path = join(LINES_DIR, `${id}.wav`);
      const render = () => this.queueRender(clean, path, () => true, glitch ? 'robot-g' : 'robot').then((ok) => (ok && void pruneLines(), ok));
      line = { id, path, ready: utimes(path, new Date(), new Date()).then(() => true, render).catch(() => false) };
      this.lines.set(key, line);
      for (const k of [...this.lines.keys()].slice(0, Math.max(0, this.lines.size - MAX_LINES))) this.lines.delete(k);
    }
    if (await line.ready) return `/files/voice/${line.id}.wav`;
    if (this.lines.get(key) === line) this.lines.delete(key);
    return null;
  }

  private queueRender(script: string, path: string, alive: () => boolean, robot?: RobotMode) {
    const run = this.chain.then(() => (alive() ? this.render(script, path, robot) : false));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private queueRecap(script: string, path: string, alive: () => boolean, choice: RenderChoice, job: Job) {
    const run = this.chain.then(async (): Promise<'kokoro' | 'codex' | false> => {
      if (!alive()) return false;
      if (!tuning().voiceRecaps) throw new Spoken(LITE_ERROR);
      if (choice.renderer === 'codex') {
        try {
          const ok = await this.renderReading(script, path, alive, async (text, target) => {
            await codexVoice.render(text, target, job.owner, job.abort.signal, choice.voice);
            return true;
          });
          return ok ? 'codex' : false;
        } catch {
          if (!alive()) return false;
          if (!this.available) throw new Spoken('Codex voice failed and no local voice is installed.');
          this.emit({ type: 'notice', message: 'Codex voice could not finish the reading. Using the local voice.' });
        }
      }
      if (!this.available) throw new Spoken(UNAVAILABLE_ERROR);
      const ok = await this.renderReading(script, path, alive, (text, target) => this.render(text, target, undefined, choice.language, job.abort.signal));
      if (!alive()) return false;
      if (!ok) throw new Spoken('The voice could not be recorded.');
      return 'kokoro';
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async renderReading(script: string, path: string, alive: () => boolean, render: (text: string, target: string) => Promise<boolean>) {
    const chunks = readingChunks(script);
    if (!chunks.length || !alive()) return false;
    if (chunks.length === 1) return render(chunks[0]!, path);
    await mkdir(join(path, '..'), { recursive: true });
    const temporary = `${path}.part`;
    const output = await open(temporary, 'w');
    const piece = `${path}.chunk.wav`;
    let header: Buffer | undefined, bytes = 0;
    try {
      for (const text of chunks) {
        if (!alive() || !await render(text, piece) || !alive()) return false;
        if (!header) {
          const first = await open(piece, 'r');
          try {
            header = Buffer.alloc(44);
            await first.read(header, 0, 44, 0);
          } finally { await first.close(); }
          await output.writeFile(header);
        }
        for await (const data of createReadStream(piece, { start: 44 })) {
          if (!alive()) return false;
          bytes += data.length;
          await output.writeFile(data);
        }
        await rm(piece, { force: true });
      }
      header!.writeUInt32LE(bytes + 36, 4);
      header!.writeUInt32LE(bytes, 40);
      await output.write(header!, 0, 44, 0);
      await output.close();
      if (!alive()) return false;
      await rename(temporary, path);
      return true;
    } finally {
      await output.close();
      await Promise.all([temporary, piece, `${piece}.part`].map((file) => rm(file, { force: true })));
    }
  }

  cancel(owner: WebSocket, sessionId: string, id: string, kind: 'recap' | 'replay') {
    if (kind === 'recap') {
      const job = this.latest.get(sessionId);
      if (job?.owner === owner && job.id === id) this.drop(sessionId, id, job.reply);
    } else for (const [key, job] of this.narrationJobs) {
      const message = this.narrating.get(key);
      if (job.owner === owner && message?.sessionId === sessionId && message.id === id) {
        job.abort.abort(); this.narrationJobs.delete(key); this.narrating.delete(key);
        this.emit({ ...message, state: 'dropped', step: null });
      }
    }
  }

  disconnect(owner: WebSocket) {
    for (const [sessionId, job] of this.latest) if (job.owner === owner) this.drop(sessionId, job.id, job.reply);
    for (const [, m] of this.narrating) this.cancel(owner, m.sessionId, m.id, 'replay');
    const preview = this.previewJobs.get(owner);
    if (preview) this.cancelPreview(owner, preview.id);
    codexVoice.drop(owner);
  }

  private current(sessionId: string, id: string) {
    return !!this.on && this.latest.get(sessionId)?.id === id;
  }

  // Evicts the session's oldest clips past the cap.
  private trim(sessionId: string) {
    const mine = [...this.clips].filter(([, c]) => c.sessionId === sessionId);
    for (const [id, c] of mine.slice(0, Math.max(0, mine.length - MAX_CLIPS))) {
      this.forget(id);
      this.emit({ type: 'voice', sessionId, id, reply: c.reply, state: 'dropped', url: null, text: '', words: 0 });
    }
  }

  private render(text: string, path: string, robot?: RobotMode, language = config.language, signal?: AbortSignal) {
    if (!tuning().voiceRecaps) throw new Spoken(LITE_ERROR);
    if (signal?.aborted) return Promise.resolve(false);
    mkdirSync(join(path, '..'), { recursive: true });
    const args = robot ? [ROBOT.voice, ROBOT.speed, ROBOT.lang, robot] : [config.voice.name, String(SPEED), language === 'pt-BR' ? 'pt-br' : 'en-us'];
    return new Promise<boolean>((resolve) => {
      // Low priority, so the UI and the agent stay responsive while it renders.
      const child = spawn('nice', ['-n', '10', PYTHON, RENDER, path, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
      this.child = child;
      const cancel = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', cancel, { once: true });
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), RENDER_MS);
      child.stderr!.on('data', (d) => (err = (err + d).slice(-2000)));
      child.on('error', () => {});
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (this.child === child) this.child = null;
        if (code !== 0) console.error(`voice render exited ${code}: ${err.split('\n').filter((l) => l && !/warn/i.test(l)).slice(-3).join(' | ')}`);
        resolve(code === 0);
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(text);
    });
  }

  private drop(sessionId: string, id: string, reply: string) {
    if (this.latest.get(sessionId)?.id === id) {
      this.latest.get(sessionId)!.abort.abort();
      this.latest.delete(sessionId);
    }
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
    const mine = (key: string) => key.startsWith(`${sessionId}:`);
    for (const key of [...this.narrating.keys()]) if (mine(key)) {
      this.narrationJobs.get(key)?.abort.abort(); this.narrationJobs.delete(key); this.narrating.delete(key);
    }
    for (const key of [...this.narrations.keys()]) if (mine(key)) this.narrations.delete(key);
    void rm(join(DIR, sessionId), { recursive: true, force: true });
  }

  close() {
    for (const [sessionId, j] of this.latest) this.drop(sessionId, j.id, j.reply);
    for (const j of this.narrationJobs.values()) j.abort.abort();
    this.narrationJobs.clear();
    for (const [owner, job] of this.previewJobs) this.cancelPreview(owner, job.id);
    codexVoice.close();
    for (const q of this.asking) q.close();
    this.child?.kill('SIGKILL');
    for (const id of [...this.clips.keys()]) this.forget(id);
    this.narrating.clear();
    for (const n of this.narrations.values()) void rm(n.path, { force: true });
    this.narrations.clear();
    for (const preview of this.previews.values()) void rm(preview.path, { force: true });
    this.previews.clear();
    // Robot lines stay on disk for the next start.
    this.lines.clear();
  }

  // GET /files/voice/<id>.wav, with byte ranges so the player can seek; false when the URL is not ours.
  async serve(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const m = /^\/files\/voice\/([\w-]{36})\.wav$/.exec(new URL(req.url ?? '/', 'http://local').pathname);
    if (!m) return false;
    const clip = this.clips.get(m[1]) ?? [...this.narrations.values(), ...this.lines.values(), ...this.previews.values()].find((n) => n.id === m[1]);
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
