import type { AgentRow, Panel, SessionSummary } from '../../server/protocol.ts';
import { getPref } from './prefs.ts';
import { useStore, type Item } from './store.ts';
import { useOutbox } from './outbox.ts';
import { onVoiceLine, send } from './socket.ts';

// The robot's sounds: one hum for the whole app while any agent works, and short spoken lines when work finishes or needs you.
// Files come from notes/promo/tools (appsounds.py, robolines.py); loaded on first use. Names are rendered live by the server.
// The hum, the lines and the effects each have a switch in Settings, read when they would play.

const HUMS = { plain: 6, glitch: 4, melody: 6 };
// How many recorded variants each spoken line has; each also has a glitched "-g" copy.
// A finish line says what kind finished; the server's live render of its name follows it.
const LINES = { sub: 5, codex: 5, job: 5, turn: 5, tab: 5, all: 6, perm: 5, question: 4, error: 4, elsewhere: 3 };
type Line = keyof typeof LINES;
type Finish = 'sub' | 'codex' | 'job' | 'turn' | 'tab';
type Urgent = 'perm' | 'question' | 'error' | 'elsewhere';
// Bunched finishes of one kind say how many, else "things"; files <group>-1…4 say 2, 3, 4 and "lots".
const COUNTS: Record<Finish, string> = { sub: 'subs', codex: 'codexes', job: 'jobs', tab: 'tabs', turn: 'tasks' };
// How long a name may trail its line before it is skipped, and the pause between them.
const NAME_WAIT = 4000;
const NAME_GAP = 0.15;
const NAME_WORDS = 6;
// The server answers every ask, but a lost socket would leave one pending forever.
const NAME_ASK_MS = 30000;
const MAX_NAMES = 30;
const HUM_EVERY = 7000;
// Short turns stay silent: the hum only joins once work has run this long without a break.
const HUM_AFTER = 40000;
// A turn shorter than this finishes without a line; a quick answer needs no announcement.
const SHORT_RUN = 40000;
// Finishes that land close together become one line, and lines keep a gap so many subagents don't chatter.
const GATHER = 1500;
const LINE_GAP = 8000;
const GLITCH_ODDS = 0.6;
const GAIN = { hum: 0.11, line: 0.55, needs: 0.45, sent: 0.4, poke: 0.35, dizzy: 0.45, jump: 0.3, jump2: 0.35, crash: 0.45, blip: 0.3, word: 0.45 };
// One-shot effects and how many variants each has; a variant never plays twice in a row.
const SFX = { poke: 3, dizzy: 1, jump: 3, jump2: 1, crash: 1, blip: 1 };
export type Sfx = keyof typeof SFX;
const lastSfx: Partial<Record<Sfx, number>> = {};
// Recalibrated after use: the old "low" felt like a medium.
const VOLUME = { low: 0.25, mid: 0.5, high: 0.8 };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let hum: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
let humTimer = 0;
let humBeat = 0;
let gatherTimer = 0;
let speakingUntil = 0;
let lastLine = -Infinity;
let lastUrgent = false;
// Bumps with every line, so a name still rendering for an older line stays quiet.
let lineNo = 0;
// Finishes waiting out GATHER, keyed so one tab or agent counts once.
const gathered = new Map<string, { kind: Finish; glitch: boolean; voice: Promise<AudioBuffer | null> | null }>();
// Live name renders by "g:" or "p:" plus text, and the asks the server has not answered yet.
const names = new Map<string, Promise<AudioBuffer | null>>();
const asked = new Map<string, (url: string | null) => void>();
// When each tab's current turn started; a tab already working when the page loaded counts as a long run.
const since = new Map<string, number>();

const pick = (n: number) => 1 + Math.floor(Math.random() * n);
const glitchy = () => Math.random() < GLITCH_ODDS;
const clip = (kind: Line, glitch: boolean) => `${kind}-${pick(LINES[kind])}${glitch ? '-g' : ''}`;

function load(name: string): Promise<AudioBuffer | null> {
  let p = buffers.get(name);
  if (!p) {
    p = fetch(`/sounds/${name}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
      .then((b) => ctx!.decodeAudioData(b))
      .catch(() => null);
    buffers.set(name, p);
  }
  return p;
}

function playBuf(buf: AudioBuffer, gain: number, rate = 1, delay = 0) {
  if (!ctx || !master || ctx.state !== 'running') return null;
  const g = ctx.createGain();
  g.gain.value = gain * VOLUME[getPref('soundVolume')];
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(g).connect(master);
  src.start(ctx.currentTime + delay);
  return { src, gain: g, secs: buf.duration / rate };
}

async function play(name: string, gain: number, rate = 1) {
  if (!ctx || !master || ctx.state !== 'running') return null;
  const buf = await load(name);
  return buf ? playBuf(buf, gain, rate) : null;
}

// What a name sounds like: about six words, without paths, hashes or code.
function spokenName(raw: string) {
  const words: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    if (/[/\\@$%^&*=<>{}[\]()`|~;]|^-|\w[.:]\w|[a-z][A-Z]|^(?=.*\d)[0-9a-fA-F-]{7,}$/.test(tok)) continue;
    for (const part of tok.split(/[-_]+/)) {
      const w = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (w && !/^(?=.*\d)[0-9a-f]{6,}$/i.test(w)) words.push(w);
    }
  }
  return words.slice(0, NAME_WORDS).join(' ');
}

// The server renders the name in the robot's voice; null without Kokoro, in Lite or when it fails, and then it is not kept.
function nameVoice(text: string, glitch: boolean): Promise<AudioBuffer | null> | null {
  if (!text || useStore.getState().voiceOn === null) return null;
  const key = `${glitch ? 'g' : 'p'}:${text}`;
  const had = names.get(key);
  if (had) return had;
  const p = new Promise<string | null>((resolve) => {
    asked.set(key, resolve);
    if (!send({ type: 'voice-line', text, glitch })) resolve(null);
    window.setTimeout(() => resolve(null), NAME_ASK_MS);
  })
    .then(async (url) => {
      asked.delete(key);
      if (!url || !ctx) return null;
      const r = await fetch(url);
      return r.ok ? await ctx.decodeAudioData(await r.arrayBuffer()) : null;
    })
    .catch(() => null)
    .then((buf) => {
      if (!buf) names.delete(key);
      return buf;
    });
  names.set(key, p);
  if (names.size > MAX_NAMES) names.delete(names.keys().next().value!);
  return p;
}

function fadeHum() {
  if (!hum || !ctx) return;
  const { src, gain } = hum;
  gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
  src.stop(ctx.currentTime + 0.3);
  hum = null;
}

const working = (r: SessionSummary) => r.state === 'working' || r.background;
const anyWork = () => useStore.getState().roster.some(working);

// 60% plain, 20% glitchy, 20% a little melody; every other beat a step lower.
async function beat() {
  humTimer = window.setTimeout(beat, HUM_EVERY);
  if (Date.now() < speakingUntil || !anyWork() || !getPref('soundHum')) return;
  const r = Math.random();
  const kind = r < 0.6 ? 'plain' : r < 0.8 ? 'glitch' : 'melody';
  const h = await play(`hum-${kind}-${pick(HUMS[kind])}`, GAIN.hum, humBeat++ % 2 ? 98 / 110 : 1);
  if (h) hum = h;
}

function syncHum() {
  if (anyWork()) {
    if (!humTimer) humTimer = window.setTimeout(beat, HUM_AFTER);
    return;
  }
  clearTimeout(humTimer);
  humTimer = 0;
  humBeat = 0;
  fadeHum();
}

// A recorded line, then the live name when one is coming; the name's render started with the event, so the line hides the wait.
async function say(file: string, isUrgent: boolean, name: Promise<AudioBuffer | null> | null = null) {
  const no = ++lineNo;
  lastLine = Date.now();
  lastUrgent = isUrgent;
  fadeHum();
  const line = await play(file, GAIN.line);
  if (!line) return;
  const ends = Date.now() + line.secs * 1000;
  speakingUntil = ends + 600;
  if (!name) return;
  const buf = await Promise.race([name, new Promise<null>((r) => window.setTimeout(() => r(null), line.secs * 1000 + NAME_WAIT))]);
  if (!buf || no !== lineNo) return;
  const delay = Math.max(0, ends - Date.now()) / 1000 + NAME_GAP;
  const said = playBuf(buf, GAIN.line, 1, delay);
  if (said) speakingUntil = Date.now() + (delay + said.secs) * 1000 + 600;
}

function speak() {
  gatherTimer = 0;
  const all = !anyWork();
  const wait = lastLine + LINE_GAP - Date.now();
  if (wait > 0) {
    // A finish inside the gap is dropped; "all done" waits its turn, unless the last line was a call for you.
    if (all && !lastUrgent) gatherTimer = window.setTimeout(speak, wait);
    else gathered.clear();
    return;
  }
  let done = [...gathered.values()];
  gathered.clear();
  // The open tab's turn speaks for its own subagents and jobs.
  if (done.some((d) => d.kind === 'turn')) done = done.filter((d) => d.kind === 'turn' || d.kind === 'tab');
  if (!done.length) return;
  const one = done.length === 1 ? done[0] : null;
  // Only a lone finish says its name; with nothing left running, a lone one elsewhere still names itself.
  if (one && !(all && one.kind === 'turn')) return void say(clip(one.kind, one.glitch), false, one.voice);
  if (all) return void say(clip('all', glitchy()), false);
  const group = done.every((d) => d.kind === done[0].kind) ? COUNTS[done[0].kind] : 'tasks';
  void say(`${group}-${Math.min(done.length, 5) - 1}${glitchy() ? '-g' : ''}`, false);
}

// key keeps one tab or agent from counting twice; only the first finish of a bunch starts a name render.
function finished(key: string, kind: Finish, name = '') {
  if (!getPref('soundVoice') || gathered.has(key)) return;
  const glitch = glitchy();
  gathered.set(key, { kind, glitch, voice: gathered.size || kind === 'turn' ? null : nameVoice(spokenName(name), glitch) });
  if (!gatherTimer) gatherTimer = window.setTimeout(speak, GATHER);
}

// A call for you beats a pending finish; inside the gap or with the voice off it falls back to the short chime, and an error stays quiet.
function urgent(kind: Urgent, tab = '') {
  clearTimeout(gatherTimer);
  gatherTimer = 0;
  gathered.clear();
  lineNo++;
  if (getPref('soundVoice') && Date.now() - lastLine >= LINE_GAP) {
    const glitch = glitchy();
    void say(clip(kind, glitch), true, tab ? nameVoice(spokenName(tab), glitch) : null);
  } else if (kind !== 'error' && getPref('soundFx')) void play('needs-you', GAIN.needs);
}

// The newest open ask on screen: a question card or AskUserQuestion, else a permission (plans included).
function askKind(order: string[], items: Record<string, Item>): Urgent {
  for (let i = order.length - 1; i >= Math.max(0, order.length - 60); i--) {
    const it = items[order[i]];
    if (it?.kind === 'permission' && it.answer === null) return it.questions?.length ? 'question' : 'perm';
    if (it?.kind === 'rich' && (it.detail.kind === 'choice' || it.detail.kind === 'round' || it.detail.kind === 'prototype' || it.detail.kind === 'checklist') && !it.result) return 'question';
  }
  return 'perm';
}

const ACTIVE: AgentRow['state'][] = ['running', 'waiting'];

// The person is looking at this window, so the tab on screen needs no word that its own turn ended.
const watching = () => document.visibilityState === 'visible' && document.hasFocus();

// The session on screen says what it needs through its asks; the others only say that they need you.
function onRoster(next: SessionSummary[], prev: SessionSummary[], current: string | null) {
  const was = new Map(prev.map((r) => [r.id, r]));
  const ids = new Set(next.map((r) => r.id));
  for (const id of since.keys()) if (!ids.has(id)) since.delete(id);
  for (const r of next) {
    const o = was.get(r.id);
    if (!o) continue;
    if (r.state === 'working' && o.state !== 'working') since.set(r.id, Date.now());
    if (r.needsYou && !o.needsYou) {
      if (r.id !== current) urgent('elsewhere', r.spoken || r.name);
    } else if (o.state === 'working' && (r.state === 'done' || r.state === 'idle')) {
      const ran = Date.now() - (since.get(r.id) ?? -Infinity);
      since.delete(r.id);
      // Subagents, Codex agents and jobs still speak; only the turn itself stays quiet.
      if (ran < SHORT_RUN || (r.id === current && watching())) continue;
      if (r.id === current) finished(`turn:${r.id}`, 'turn');
      else finished(`tab:${r.id}`, 'tab', r.spoken || r.name);
    } else if (o.background && !r.background && r.id !== current) finished(`tab:${r.id}`, 'tab', r.spoken || r.name);
  }
  syncHum();
}

// Subagents, Codex agents and background jobs of the session on screen; the roster only says when another tab's last one stops.
function onPanel(next: Panel | undefined, prev: Panel | undefined) {
  if (!next || !prev) return;
  const was = new Map(prev.agents.map((a) => [a.id, a]));
  for (const a of next.agents) {
    const o = was.get(a.id);
    // A workflow's own agents are covered by the run's row.
    if (!a.main && !a.parent && o && ACTIVE.includes(o.state) && !ACTIVE.includes(a.state)) finished(`agent:${a.id}`, a.kind === 'codex' ? 'codex' : 'sub', a.name);
  }
  const ran = new Set(prev.procs.filter((p) => p.state === 'running').map((p) => p.id));
  for (const p of next.procs) if (ran.has(p.id) && p.state !== 'running') finished(`proc:${p.id}`, 'job', p.label ?? p.command);
}

// A short effect, e.g. a click on the robot. Silent until start() ran; a missing file stays silent.
export async function oneShot(kind: Sfx) {
  if (!ctx) return;
  // The click that asks for it is the gesture that unlocks audio, but resume() lands after this call.
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const n = SFX[kind];
  let v = pick(n);
  if (n > 1 && v === lastSfx[kind]) v = (v % n) + 1;
  lastSfx[kind] = v;
  void play(n > 1 ? `${kind}-${v}` : kind, GAIN[kind]);
}

// One of the runner's speech-bubble words, hop-1…hop-10; same unlock and silence rules as oneShot.
export async function word(n: number) {
  if (!ctx) return;
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  void play(`hop-${n}`, GAIN.word);
}

// Browsers keep audio locked until the page gets a gesture.
const unlock = () => void ctx?.resume();

export function start() {
  ctx = new AudioContext();
  master = ctx.createGain();
  master.connect(ctx.destination);
  addEventListener('pointerdown', unlock);
  addEventListener('keydown', unlock);
  onVoiceLine((m) => asked.get(`${m.glitch ? 'g' : 'p'}:${m.text}`)?.(m.url));
  const unsub = useStore.subscribe((s, old) => {
    if (s.roster !== old.roster) onRoster(s.roster, old.roster, s.current);
    if (!s.current || s.current !== old.current) return;
    if (s.panels !== old.panels) onPanel(s.panels[s.current], old.panels[s.current]);
    if (s.asks > old.asks) urgent(askKind(s.order, s.items));
    const last = s.order.at(-1);
    if (last && last !== old.order.at(-1) && s.items[last]?.kind === 'error') urgent('error');
  });
  // Every composer sends through the outbox; rows restored after a reload are old, so the age check skips them.
  const unsubSent = useOutbox.subscribe((s, old) => {
    const last = s.list.at(-1);
    if (last && last !== old.list.at(-1) && Date.now() - last.at < 1000 && getPref('soundFx')) void play('sent', GAIN.sent);
  });
  syncHum();
  return () => {
    unsub();
    unsubSent();
    removeEventListener('pointerdown', unlock);
    removeEventListener('keydown', unlock);
    clearTimeout(humTimer);
    clearTimeout(gatherTimer);
    humTimer = gatherTimer = 0;
    hum = null;
    onVoiceLine(null);
    gathered.clear();
    names.clear();
    asked.clear();
    buffers.clear();
    void ctx?.close();
    ctx = master = null;
  };
}
