import type { AgentRow, Panel, SessionSummary } from '../../server/protocol.ts';
import { getPref } from './prefs.ts';
import { useStore } from './store.ts';

// The robot's sounds: one hum for the whole app while any agent works, and a short spoken line when work finishes.
// Files come from notes/promo/tools (appsounds.py, robolines.py); loaded on first use.

const HUMS = { plain: 6, glitch: 4, melody: 6 };
const DONE_LINES = 11;
const ALL_LINES = 6;
const HUM_EVERY = 7000;
// Finishes that land close together become one line, and lines keep a gap so many subagents don't chatter.
const GATHER = 1500;
const LINE_GAP = 8000;
const GLITCH_ODDS = 0.25;
const GAIN = { hum: 0.22, line: 0.55, needs: 0.45 };
const VOLUME = { low: 0.5, mid: 1, high: 1.6 };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let hum: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
let humTimer = 0;
let humBeat = 0;
let gatherTimer = 0;
let speakingUntil = 0;
let lastLine = -Infinity;

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
  if (Date.now() < speakingUntil || !anyWork()) return;
  const r = Math.random();
  const kind = r < 0.6 ? 'plain' : r < 0.8 ? 'glitch' : 'melody';
  const h = await play(`hum-${kind}-${pick(HUMS[kind])}`, GAIN.hum, humBeat++ % 2 ? 98 / 110 : 1);
  if (h) hum = h;
}

function syncHum() {
  if (anyWork()) {
    if (!humTimer) humTimer = window.setTimeout(beat, HUM_EVERY);
    return;
  }
  clearTimeout(humTimer);
  humTimer = 0;
  humBeat = 0;
  fadeHum();
}

async function speak() {
  gatherTimer = 0;
  const all = !anyWork();
  const wait = lastLine + LINE_GAP - Date.now();
  if (wait > 0) {
    // A "done" inside the gap is dropped; the last one still gets said once the gap ends.
    if (all) gatherTimer = window.setTimeout(speak, wait);
    return;
  }
  lastLine = Date.now();
  fadeHum();
  const n = all ? pick(ALL_LINES) : pick(DONE_LINES);
  const line = await play(`${all ? 'all' : 'done'}-${n}${Math.random() < GLITCH_ODDS ? '-g' : ''}`, GAIN.line);
  if (line) speakingUntil = Date.now() + line.secs * 1000 + 600;
}

function finished() {
  if (!gatherTimer) gatherTimer = window.setTimeout(speak, GATHER);
}

const ACTIVE: AgentRow['state'][] = ['running', 'waiting'];

function onRoster(next: SessionSummary[], prev: SessionSummary[]) {
  const was = new Map(prev.map((r) => [r.id, r]));
  for (const r of next) {
    const o = was.get(r.id);
    if (!o) continue;
    if (r.needsYou && !o.needsYou) void play('needs-you', GAIN.needs);
    else if ((o.state === 'working' && (r.state === 'done' || r.state === 'idle')) || (o.background && !r.background)) finished();
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

// Browsers keep audio locked until the page gets a gesture.
const unlock = () => void ctx?.resume();

export function start() {
  ctx = new AudioContext();
  master = ctx.createGain();
  master.connect(ctx.destination);
  addEventListener('pointerdown', unlock);
  addEventListener('keydown', unlock);
  const unsub = useStore.subscribe((s, old) => {
    if (s.roster !== old.roster) onRoster(s.roster, old.roster);
    if (s.current && s.current === old.current && s.panels !== old.panels) onPanel(s.panels[s.current], old.panels[s.current]);
  });
  syncHum();
  return () => {
    unsub();
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
