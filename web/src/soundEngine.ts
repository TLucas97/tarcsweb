import type { SessionSummary } from '../../server/protocol.ts';
import { getPref } from './prefs.ts';
import { useStore } from './store.ts';
import { useOutbox } from './outbox.ts';
import { useTerminal } from './terminal.ts';

// The robot's sounds: one hum for the whole app while any agent works, and a chime when a session needs you. It never speaks on its own.
// Files come from notes/promo/tools (appsounds.py, robolines.py); loaded on first use.
// The hum and the effects each have a switch in Settings, read when they would play.

const HUMS = { plain: 6, glitch: 4, melody: 6 };
const HUM_EVERY = 7000;
// Short turns stay silent: the hum only joins once work has run this long without a break.
const HUM_AFTER = 40000;
const GAIN = { hum: 0.11, needs: 0.45, sent: 0.4, poke: 0.35, dizzy: 0.45, jump: 0.3, jump2: 0.35, crash: 0.45, blip: 0.3, word: 0.45, tick: 0.045 };
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
  if (!buf || !ctx || !master || ctx.state !== 'running') return null;
  const g = ctx.createGain();
  g.gain.value = gain * VOLUME[getPref('soundVolume')];
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(g).connect(master);
  src.start();
  return { src, gain: g };
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
  if (!anyWork() || !getPref('soundHum')) return;
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

function needsYou() {
  if (getPref('soundFx')) void play('needs-you', GAIN.needs);
}

// The session on screen rings through its asks; another one rings when it starts needing you.
function onRoster(next: SessionSummary[], prev: SessionSummary[], current: string | null) {
  const was = new Map(prev.map((r) => [r.id, r]));
  for (const r of next) {
    const o = was.get(r.id);
    if (o && r.needsYou && !o.needsYou && r.id !== current) {
      needsYou();
      break;
    }
  }
  syncHum();
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

// The reading tick, synthesized: a short rising sine bubble; a sentence end sits lower and rings longer.
export function readTick(end: boolean) {
  if (!ctx || !master || ctx.state !== 'running') return;
  const p = end ? 0.78 : 1;
  const dec = end ? 0.096 : 0.06;
  const t = ctx.currentTime + 0.005;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(326 * p, t);
  o.frequency.exponentialRampToValueAtTime(612 * p, t + 0.035);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(GAIN.tick * VOLUME[getPref('soundVolume')], t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dec + 0.02);
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
    if (s.current && s.current === old.current && s.asks > old.asks) needsYou();
  });
  // A new ask from a terminal session rings too.
  const unsubTerminal = useTerminal.subscribe((s, old) => {
    const seen = new Set(old.sessions.flatMap((t) => t.asks.map((a) => a.id)));
    if (s.sessions.some((t) => t.asks.some((a) => !seen.has(a.id)))) needsYou();
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
    unsubTerminal();
    removeEventListener('pointerdown', unlock);
    removeEventListener('keydown', unlock);
    clearTimeout(humTimer);
    humTimer = 0;
    hum = null;
    buffers.clear();
    void ctx?.close();
    ctx = master = null;
  };
}
