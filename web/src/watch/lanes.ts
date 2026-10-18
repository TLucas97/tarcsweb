import { clamp, eio } from '../robot.tsx';
import { loco } from './director.ts';
import type { Action, AgentEnd, AgentNote, Row, Station, WatchModel } from './model.ts';

// Multi-robot: each agent is a small robot on its own lane above the stage. The lane branches off a plug beside the
// station where he spawned it and merges back where its result returned. Every pose is a pure function of view time T.

// Floor of lane 0, in world units (the stage floor is at 400); each next lane sits one lane height above.
export const LANE_Y0 = -8;
// The riser leaves the floor this far right of the spawning station, clear of its title.
export const RISE = 196;
export const STEP = 64;
const START = 36;
export const BOT_H = 50;
export const FLY = 0.6;
// After a merge: how long the outcome stays before the lane fades to a thin line.
const SETTLE = 3;

export type Lane = { row: Row; st: Station; slot: number; bx: number };
export type LaneState = 'running' | 'done' | 'failed' | 'stopped';
export type Pose = {
  lane: Lane; e: AgentEnd; s: LaneState; note: AgentNote | null;
  // Robot x, how high a hop lifts it, landing squash; moving: drawn on the per-frame layer until view time `until`.
  x: number; lift: number; sq: number; moving: boolean; until: number;
  // A slow walk over a whole run (history): 20 fps world repaints are enough for it.
  slow: boolean;
  // Steps reached and known (0: open-ended); its latest action and how many it had made, by T or its end.
  k: number; n: number; act: Action | null; count: number;
  // View times: its face lands on the lane, it leaves the lane (merge) and its face is home.
  tIn: number; tOut: number; tHome: number;
  // Where the lane comes back down to the stage floor (NaN while it runs), and how far it faded to a thin line.
  mx: number; body: number; fade: number;
};

// Long open-ended runs pack their later steps closer, so a busy agent's lane stays on screen.
const spread = (k: number) => (k <= 6 ? k : 6 + 4 * Math.log2(1 + (k - 6) / 4));
export const stepX = (l: Lane, k: number) => l.bx + START + STEP * spread(Math.max(0, k));
const stepOf = (n: AgentNote) => (n.d >= 0 && n.n > 0 ? n.d : n.i);
// Wall seconds for a hop across dk steps.
const hopDur = (dk: number) => clamp(0.3 + 0.14 * Math.abs(dk), 0.42, 1.1);

// The newest note at or before wall time w, by index.
function noteAt(l: readonly AgentNote[], w: number) {
  for (let i = l.length - 1; i >= 0; i--) if (l[i].w <= w) return i;
  return -1;
}

// Robot x at wall time w from the notes: each note hops it from the previous note's step to its own.
function xAt(lane: Lane, l: readonly AgentNote[], j: number, w: number, depth = 1): { x: number; u: number; dk: number; left: number } {
  if (j < 0) return { x: stepX(lane, 0), u: 1, dk: 0, left: 0 };
  const k1 = stepOf(l[j]), k0 = j > 0 ? stepOf(l[j - 1]) : 0, dur = hopDur(k1 - k0);
  // A hop cut short by the next note starts from where the last one had got to.
  const x0 = depth > 0 && j > 0 ? xAt(lane, l, j - 1, l[j].w, depth - 1).x : stepX(lane, k0);
  const u = clamp((w - l[j].w) / dur, 0, 1);
  return { x: x0 + (stepX(lane, k1) - x0) * eio(u), u, dk: k1 - k0, left: l[j].w + dur - w };
}

export function pose(m: WatchModel, lane: Lane, T: number, still: boolean): Pose {
  const r = lane.row, e = m.agentEnd(r), notes = m.agentNotes(r.aid);
  const tIn = r.t + 0.05 + FLY;
  const E = e.end, ended = E !== null && T >= E;
  const s = (ended ? (e.fin === 'waiting' ? 'running' : e.fin) : 'running') as LaneState;
  const w = m.wallOf(Math.min(T, E ?? Infinity));
  const j = noteAt(notes, w);
  const note = j >= 0 ? notes[j] : null;
  const n = note && note.n > 0 ? note.n : 0;
  const { act, count } = m.actionAt(r.aid, Math.min(T, E ?? Infinity));
  const p: Pose = {
    lane, e, s, note, x: stepX(lane, 0), lift: 0, sq: 0, moving: false, until: -Infinity, slow: false, k: note ? stepOf(note) : 0, n, act, count,
    tIn, tOut: Infinity, tHome: Infinity, mx: NaN, body: still ? 1 : clamp((T - tIn) / 0.25, 0, 1), fade: 0,
  };
  const at = xAt(lane, notes, j, w);
  if (E === null) {
    p.x = at.x;
    if (!still && at.u < 1 && at.dk) hop(p, at.u, T + at.left);
    ride(p, m, T, still);
    return p;
  }
  // Ended: back down to the floor beside where he stands when the result returns, past where the robot got to.
  const blind = !notes.length;
  const xEnd = Math.max(blind ? stepX(lane, 0) : at.x, rideX(m, E));
  p.mx = Math.max(loco(m, E).x + RISE, xEnd + (blind ? 3 * STEP : 44));
  // No steps seen (history): it walks the lane from start to end over its whole run.
  const tEnd = blind ? Math.max(E, tIn + 0.6) : E;
  const walk = blind || p.s === 'failed' || still ? 0 : clamp((p.mx - xEnd) / 240, 0.35, 1.3);
  p.tOut = tEnd + walk;
  p.tHome = p.tOut + (p.s === 'failed' ? 0 : FLY);
  if (blind) {
    const x0 = stepX(lane, 0), u = clamp((T - tIn) / (tEnd - tIn), 0, 1);
    p.x = x0 + (p.mx - x0) * u;
    if (!still && u > 0 && u < 1) (walking(p, x0, tEnd), (p.slow = true));
    if (!ended) ride(p, m, T, still);
  } else if (!ended) {
    p.x = at.x;
    if (!still && at.u < 1 && at.dk) hop(p, at.u, T + at.left);
    ride(p, m, T, still);
  } else if (p.s === 'failed') p.x = xEnd;
  else {
    const u = walk ? clamp((T - E) / walk, 0, 1) : 1;
    p.x = xEnd + (p.mx - xEnd) * eio(u);
    if (u > 0 && u < 1) walking(p, xEnd, p.tOut);
  }
  // Done or stopped: the body fades as its face lifts off home. Failed: it stays where it stopped, dimmed.
  if (p.s !== 'failed' && !still) p.body *= 1 - clamp((T - p.tOut) / 0.25, 0, 1);
  else if (p.s !== 'failed') p.body = T >= p.tOut ? 0 : p.body;
  p.fade = still ? (T >= p.tHome ? 1 : 0) : clamp((T - p.tHome - SETTLE) / 0.6, 0, 1);
  return p;
}

// A running lane robot never falls behind him: it keeps at least the offset it spawned with.
const rideX = (m: WatchModel, T: number) => loco(m, T).x + RISE + START;
function ride(p: Pose, m: WatchModel, T: number, still: boolean) {
  const l = loco(m, T), x = l.x + RISE + START;
  if (x <= p.x) return;
  p.x = x;
  // Carried while he walks: it strides along, and a progress hop still lifts it in place.
  if (!still && l.moving && !p.lift) (walking(p, p.lane.bx, T + 0.25), (p.slow = false));
  else if (!still && l.moving) (p.moving = true), (p.until = Math.max(p.until, T + 0.25)), (p.slow = false);
}

// A hop: a small arc and a squash as it lands.
function hop(p: Pose, u: number, until: number) {
  p.moving = true;
  p.until = until;
  p.lift = 16 * Math.sin(Math.PI * clamp((u - 0.1) / 0.8, 0, 1));
  p.sq = u > 0.85 ? 0.14 * Math.sin(Math.PI * (u - 0.85) / 0.15) : u < 0.1 ? 0.1 * Math.sin(Math.PI * u / 0.1) : 0;
}

// A steady walk along the lane, bobbing with each stride.
function walking(p: Pose, x0: number, until: number) {
  p.moving = true;
  p.until = until;
  p.lift = 3 * Math.abs(Math.sin((p.x - x0) / 11));
}

// Worth framing at T: from its spawn until its lane has faded to a thin line after the merge.
export const live = (p: Pose, T: number) => T >= p.lane.row.t && T < p.tHome + SETTLE + 0.6;

// How far right an ended lane reaches, so a later lane can reuse its height; Infinity while it runs.
export function laneEnd(m: WatchModel, l: Lane) {
  const p = pose(m, l, Infinity, true);
  return p.e.end === null ? Infinity : Math.max(p.mx, p.x);
}
