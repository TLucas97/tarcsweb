import { useSyncExternalStore } from 'react';
import type { MachineFacts } from '../../server/protocol.ts';
import { isLite, perfChosen, subscribe as onPerf } from './perf.ts';

// First-guess thresholds, all in one place. Points add up per group (memory, cpu) by max, then across groups.
const POINTS = {
  serverRam: [[4, 4], [8, 2]], // [GiB at or below, points]
  deviceMemory: [[2, 3], [4, 1]],
  serverCores: [[2, 3], [4, 1]],
  browserCores: [[2, 3], [4, 1]],
  softwareGl: 3,
  rosetta: 1,
  suggestAt: 4,
} as const;

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic/i;
const GIB = 1024 ** 3;
const SNOOZE_KEY = 'cw:lite-snooze';
const SNOOZE_MS = 7 * 24 * 3600_000;

type Pick = { points: number; value: number };
const pick = (table: readonly (readonly [number, number])[], value: number | null | undefined): Pick => {
  if (!value || value <= 0) return { points: 0, value: 0 };
  for (const [max, points] of table) if (value <= max) return { points, value };
  return { points: 0, value };
};
const better = (a: Pick, b: Pick) => (b.points > a.points ? b : a);

let facts: MachineFacts | null = null;
// null until the probe ran; false also covers "no WebGL", which scores nothing.
let softwareGl: boolean | null = null;

function probeGl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return SOFTWARE_GL.test(name);
  } catch {
    return false;
  }
}

const gb = (n: number) => Math.max(1, Math.round(n));

export function assess(): { score: number; reason: string } {
  const f = facts;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ramGiB = f ? Math.min(f.totalMemory, f.constrainedMemory ?? Infinity) / GIB : null;
  const memory = better(pick(POINTS.serverRam, ramGiB), pick(POINTS.deviceMemory, nav.deviceMemory));
  const cpu = better(pick(POINTS.serverCores, f?.cpus), pick(POINTS.browserCores, navigator.hardwareConcurrency));
  const software = softwareGl === true;
  const rosetta = f?.rosetta === true;
  const score = memory.points + cpu.points + (software ? POINTS.softwareGl : 0) + (rosetta ? POINTS.rosetta : 0);

  const has: string[] = [];
  if (memory.points) has.push(`${gb(memory.value)} GB of memory`);
  if (cpu.points) has.push(`${cpu.value} processor ${cpu.value === 1 ? 'core' : 'cores'}`);
  if (software) has.push('no graphics acceleration');
  const list = has.length > 1 ? `${has.slice(0, -1).join(', ')} and ${has.at(-1)}` : has[0];
  const parts = [list && `This computer has ${list}.`, rosetta && 'tarcsweb is running through Rosetta.'].filter(Boolean);
  return { score, reason: parts.join(' ') };
}

// The card shows this text; null hides it.
let suggestion: string | null = null;
const listeners = new Set<() => void>();
const setSuggestion = (next: string | null) => {
  if (next === suggestion) return;
  suggestion = next;
  for (const fn of listeners) fn();
};
export const useSuggestion = () =>
  useSyncExternalStore((fn) => (listeners.add(fn), () => void listeners.delete(fn)), () => suggestion);

export const snoozed = () => {
  try {
    return Date.now() < Number(localStorage.getItem(SNOOZE_KEY));
  } catch {
    return false;
  }
};
export function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {}
  hide();
}
export const hide = () => setSuggestion(null);

// Once per page load, and only while no profile was ever chosen.
let offered = false;
let stopMonitor: (() => void) | null = null;
const eligible = () => facts !== null && !offered && perfChosen() === false && !isLite() && !snoozed();

function offer(reason: string) {
  offered = true;
  stopMonitor?.();
  stopMonitor = null;
  setSuggestion(reason);
}

const idle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 1000));

let probing = false;
function check() {
  if (!eligible() || probing || softwareGl !== null) return;
  probing = true;
  idle(() => {
    probing = false;
    if (!eligible()) return;
    softwareGl = probeGl();
    const { score, reason } = assess();
    if (score >= POINTS.suggestAt) offer(reason);
  });
}

function startMonitor() {
  if (stopMonitor) return;
  let stopped = false;
  stopMonitor = () => (stopped = true);
  // Loaded on demand: the observer and its listeners are not needed for anyone who never gets this far.
  void import('./lagMonitor.ts').then(({ watchLag }) => {
    if (stopped || !eligible()) return;
    stopMonitor = watchLag(() => offer('tarcsweb has been stuttering on this computer.'));
  });
}

// Every server `machine` message lands here; it only arrives while no profile was chosen or forced, so it also gates the monitor.
export function setMachine(next: MachineFacts) {
  facts = next;
  check();
  if (eligible()) startMonitor();
}

// The profile or the chosen flag moved (this or another window): drop the card and the monitor once they no longer apply.
onPerf(() => {
  if (perfChosen() === false && !isLite()) return;
  stopMonitor?.();
  stopMonitor = null;
  hide();
});

// ?lite-suggest=1 forces the hardware card and ?lite-suggest=stutter the stuttering one, skipping every gate.
const force = new URLSearchParams(location.search).get('lite-suggest');
if (force) {
  idle(() => {
    softwareGl = probeGl();
    const real = assess().reason;
    setSuggestion(force === 'stutter' ? 'tarcsweb has been stuttering on this computer.' : real || 'This computer has 4 GB of memory and no graphics acceleration.');
  });
}
