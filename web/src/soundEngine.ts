import type { AgentRow, Panel, SessionSummary } from '../../server/protocol.ts';
import { getPref } from './prefs.ts';
import { useStore, type Item } from './store.ts';
import { useOutbox } from './outbox.ts';

// The robot's sounds: one hum for the whole app while any agent works, and short spoken lines when work finishes or needs you.
// Files come from notes/promo/tools (appsounds.py, robolines.py); loaded on first use.
// The hum, the lines and the effects each have a switch in Settings, read when they would play.

const HUMS = { plain: 6, glitch: 4, melody: 6 };
// How many recorded variants each spoken line has; each also has a glitched "-g" copy.
const LINES = { done: 11, all: 6, perm: 5, question: 4, error: 4, elsewhere: 3 };
type Line = keyof typeof LINES;
const HUM_EVERY = 7000;
// Short turns stay silent: the hum only joins once work has run this long without a break.
const HUM_AFTER = 40000;
// Finishes that land close together become one line, and lines keep a gap so many subagents don't chatter.
const GATHER = 1500;
const LINE_GAP = 8000;
const GLITCH_ODDS = 0.25;
const GAIN = { hum: 0.22, line: 0.55, needs: 0.45, sent: 0.4, poke: 0.35, dizzy: 0.45, jump: 0.3, jump2: 0.35, crash: 0.45, blip: 0.3, word: 0.45 };
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
let lastKind: Line | null = null;

const pick = (n: number) => 1 + Math.floor(Math.random() * n);

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

async function play(name: string, gain: number, rate = 1) {
  if (!ctx || !master || ctx.state !== 'running') return null;
  const buf = await load(name);
  if (!buf || !ctx || !master) return null;
  const g = ctx.createGain();
  g.gain.value = gain * VOLUME[getPref('soundVolume')];
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(g).connect(master);
  src.start();
  return { src, gain: g, secs: buf.duration / rate };
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

async function say(kind: Line) {
  lastLine = Date.now();
  lastKind = kind;
  fadeHum();
  const line = await play(`${kind}-${pick(LINES[kind])}${Math.random() < GLITCH_ODDS ? '-g' : ''}`, GAIN.line);
  if (line) speakingUntil = Date.now() + line.secs * 1000 + 600;
}

function speak() {
  gatherTimer = 0;
  const all = !anyWork();
  const wait = lastLine + LINE_GAP - Date.now();
  if (wait > 0) {
    // A "done" inside the gap is dropped; "all done" waits its turn, unless the last line was a call for you.
    if (all && (lastKind === 'done' || lastKind === 'all')) gatherTimer = window.setTimeout(speak, wait);
    return;
  }
  void say(all ? 'all' : 'done');
}

function finished() {
  if (!gatherTimer && getPref('soundVoice')) gatherTimer = window.setTimeout(speak, GATHER);
}

// A call for you beats a pending "done"; inside the gap or with the voice off it falls back to the short chime, and an error stays quiet.
function urgent(kind: Line) {
  clearTimeout(gatherTimer);
  gatherTimer = 0;
  if (getPref('soundVoice') && Date.now() - lastLine >= LINE_GAP) void say(kind);
  else if (kind !== 'error' && getPref('soundFx')) void play('needs-you', GAIN.needs);
}

// The newest open ask on screen: a question card or AskUserQuestion, else a permission (plans included).
function askKind(order: string[], items: Record<string, Item>): Line {
  for (let i = order.length - 1; i >= Math.max(0, order.length - 60); i--) {
    const it = items[order[i]];
    if (it?.kind === 'permission' && it.answer === null) return it.questions?.length ? 'question' : 'perm';
    if (it?.kind === 'rich' && (it.detail.kind === 'choice' || it.detail.kind === 'round') && !it.result) return 'question';
  }
  return 'perm';
}

const ACTIVE: AgentRow['state'][] = ['running', 'waiting'];

// The session on screen says what it needs through its asks; the others only say that they need you.
function onRoster(next: SessionSummary[], prev: SessionSummary[], current: string | null) {
  const was = new Map(prev.map((r) => [r.id, r]));
  for (const r of next) {
    const o = was.get(r.id);
    if (!o) continue;
    if (r.needsYou && !o.needsYou) {
      if (r.id !== current) urgent('elsewhere');
    } else if ((o.state === 'working' && (r.state === 'done' || r.state === 'idle')) || (o.background && !r.background)) finished();
  }
  syncHum();
}

// Subagents and Codex agents of the session on screen; the roster only says when a background session's last one stops.
function onPanel(next: Panel | undefined, prev: Panel | undefined) {
  if (!next || !prev) return;
  const was = new Map(prev.agents.map((a) => [a.id, a]));
  for (const a of next.agents) {
    const o = was.get(a.id);
    if (!a.main && o && ACTIVE.includes(o.state) && !ACTIVE.includes(a.state)) finished();
  }
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
    buffers.clear();
    void ctx?.close();
    ctx = master = null;
  };
}
