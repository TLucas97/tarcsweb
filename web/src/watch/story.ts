import type { Action, Row } from './model.ts';
import type { Lane } from './lanes.ts';

// Watch mode's story tree: what each agent did at a station, as a subway-map line that climbs up and to the right.
// Every folder, summary line or card is a stop on its agent's trunk, each stop on its own row; a folder's files hang
// off it on the rows above. Placement is append-only, so nothing already drawn ever moves; world.ts draws it at T.

const FLOOR = 400;
// Row pitch, and how far a label may reach right of its node (and the least room one needs).
export const RH = 21;
export const LABEL_W = 220;
const LABEL_MIN = 150;
// Each stop moves right by DX_MIN plus up to DX_VAR (hashed from the call, so it is stable); some climb an extra row.
const DX_MIN = 38;
const DX_VAR = 56;
const SKIP = 0.3;
// Along the height ceiling, stops sit this far apart so their labels never meet.
const TOP_DX = 236;
// Main agent: first stop right of the station, rising from just above the floor to the ceiling. Stops left of
// TITLE_X stay below TITLE_Y, under the station's title.
export const MAIN_X0 = 130;
const MAIN_Y0 = FLOOR - 26;
const MAIN_CEIL = 50;
const TITLE_X = 196;
const TITLE_Y = 206;
// Subagent boxes sit low with a clear height stagger; their lines may climb above the stage (the camera zooms out).
export const BOX_HALF = 18;
const BOX_Y = [FLOOR - 62, FLOOR - 142, FLOOR - 102, FLOOR - 182];
const SUB_CEIL = -60;
// Room a stack keeps ahead of its newest stop when a column opens to its right.
const ROOM_FWD = LABEL_W + 160;
// Files a folder visit shows before the rest only count in its label; caps.
const SHOW = 4;
const NODES_MAX = 600;
const ACTS_MAX = 24;
const HIDDEN_MAX = 200;
const GROUP_MAX = 200;

export type NodeKind = 'fork' | 'file' | 'run' | 'search' | 'other' | 'agent' | 'needs' | 'fault' | 'more' | 'calls';
export type Node = {
  kind: NodeKind; who: string; t: number; depth: 1 | 2;
  // x relative to the station, y in world units; the row it sits on within its stack.
  x: number; y: number; r: number;
  // A file's path, a folder, or the label of a call or card.
  path: string;
  // The calls behind it; a question or error card's row.
  acts: Action[]; row: Row | null;
  // The stop before it on the trunk (null: the trunk's base), the folder a file hangs from.
  from: Node | null; fork: Node | null;
  // The y of an empty row the trunk steps through on its way here (NaN: one riser); on the ceiling run.
  skip: number; top: boolean;
  // A folder's shown files and the ones only counted; a "+k more" node's folded calls.
  kids: Node[]; hid: Node[];
};
// x: the box's left edge relative to the station; y: its centre.
export type Box = { lane: Lane; i: number; t: number; x: number; y: number };
type Stack = {
  who: string; sub: boolean; x0: number; y0: number; ceil: number;
  // Next free row, the newest stop, the open folder visit, the "+k more" node, the summary line calls can join.
  r: number; last: Node | null; fork: Node | null; over: Node | null; pack: Node | null;
  // Right limit for labels (Infinity while nothing stands to its right); x of the newest stop on the ceiling row.
  wall: number; topX: number;
};
// end: right edge of everything drawn, relative to the station; top: the highest y anything reaches.
export type Story = { nodes: Node[]; boxes: Box[]; stacks: Map<string, Stack>; end: number; top: number };

export const newStory = (): Story => ({ nodes: [], boxes: [], stacks: new Map(), end: 0, top: Infinity });

// "web/src/watch/model.ts" → "web/src/watch/"; a file at the root is in "./".
export const folderOf = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? './' : p.slice(0, i + 1);
};
export const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;

// A stable 0..1 from a call id, so the line's steps vary but never change between rebuilds.
function rnd(id: string, salt: number) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

const kindOf = (verb: string): NodeKind =>
  verb === 'read' || verb === 'edit' || verb === 'write' ? 'file'
  : verb === 'run' || verb === 'background' ? 'run'
  : verb === 'search' || verb === 'web' ? 'search'
  : verb === 'agent' ? 'agent'
  : 'other';

// A summary line of quiet calls; a named check keeps its own stop and label.
export const quiet = (n: Node) => n.kind === 'calls';

const rowY = (k: Stack, r: number) => k.y0 - r * RH;
const maxRow = (k: Stack) => Math.floor((k.y0 - k.ceil) / RH);

type Slot = { x: number; y: number; r: number; skip: number; top: boolean };
// Where the next stop goes: up a row (sometimes two) and right; once out of rows, along the ceiling. null: no room.
function slot(k: Stack, rows: number, id: string, need = LABEL_MIN): Slot | null {
  const mr = maxRow(k), last = k.last, lx = last ? last.x : k.x0;
  let r = k.r, skip = NaN;
  if (last && rnd(id, 1) < SKIP && r + rows <= mr) (skip = rowY(k, r)), r++;
  if (r + rows - 1 <= mr) {
    let x = last ? lx + DX_MIN + rnd(id, 2) * DX_VAR : k.x0;
    if (!k.sub && rowY(k, r + rows - 1) < TITLE_Y) x = Math.max(x, TITLE_X);
    // Near the wall the line climbs straight up instead.
    x = Math.max(lx, Math.min(x, k.wall - need));
    if (x + need > k.wall && last) return null;
    return { x, y: rowY(k, r), r, skip, top: false };
  }
  const x = Math.max(lx + DX_MIN, k.topX + TOP_DX);
  return x + need > k.wall ? null : { x, y: rowY(k, mr), r: mr, skip: NaN, top: true };
}

function put(s: Story, k: Stack, kind: NodeKind, t: number, path: string, at: Slot, depth: 1 | 2): Node {
  const n: Node = {
    kind, who: k.who, t, depth, x: at.x, y: at.y, r: at.r, path, acts: [], row: null,
    from: depth === 1 ? k.last : null, fork: null, skip: at.skip, top: at.top, kids: [], hid: [],
  };
  s.nodes.push(n);
  s.end = Math.max(s.end, n.x + LABEL_W);
  s.top = Math.min(s.top, n.y);
  if (at.r >= k.r) k.r = at.r + 1;
  if (at.r === maxRow(k)) k.topX = Math.max(k.topX, at.x);
  if (depth === 1) (k.last = n), (k.pack = null);
  return n;
}

// A stop for a depth-1 node, keeping one more slot free for "+k more"; null when everything after folds.
function stop(s: Story, k: Stack, kind: NodeKind, t: number, path: string, id: string, rows: number): Node | null {
  if (k.over || s.nodes.length >= NODES_MAX) return null;
  const at = slot(k, rows, id);
  // If nothing would fit after this stop, it becomes the "+k more" node instead.
  const after = at && slot({ ...k, last: { x: at.x } as Node, r: at.r + rows, topX: at.r + rows - 1 >= maxRow(k) ? Math.max(k.topX, at.x) : k.topX }, 1, id + '+', 80);
  if (!at || !after) {
    const o = at ?? slot(k, 1, id, 80);
    if (!o) return null;
    k.fork = null;
    k.over = put(s, k, 'more', t, '', o, 1);
    return null;
  }
  return put(s, k, kind, t, path, at, 1);
}

const loose = (kind: NodeKind, who: string, t: number, path: string, a: Action | null, row: Row | null): Node => ({
  kind, who, t, depth: 2, x: 0, y: 0, r: -1, path, acts: a ? [a] : [], row, from: null, fork: null, skip: NaN, top: false, kids: [], hid: [],
});

function fold(k: Stack, kind: NodeKind, t: number, path: string, a: Action | null, row: Row | null) {
  if (k.over && k.over.hid.length < HIDDEN_MAX) k.over.hid.push(loose(kind, k.who, t, path, a, row));
}

// Returns whether the tree reaches further right, so the floor after the station can make room.
export function addAct(s: Story, who: string, a: Action) {
  const k = s.stacks.get(who) ?? (who === 'main' ? mainStack(s) : null);
  if (!k) return false;
  const end = s.end, kind = kindOf(a.verb);
  if (kind !== 'file') {
    k.fork = null;
    const p = k.pack, hush = !(kind === 'run' && a.check);
    // Consecutive quiet calls share one summary line ("6 commands · 2 failed").
    if (hush && p && p === k.last) {
      if (p.acts.length < GROUP_MAX) p.acts.push(a);
      return false;
    }
    const n = stop(s, k, hush ? 'calls' : kind, a.t, a.label, a.id, 1);
    if (!n) fold(k, kind, a.t, a.label, a, null);
    else {
      n.acts.push(a);
      if (hush) k.pack = n;
    }
    return s.end !== end;
  }
  const dir = folderOf(a.path);
  const f = k.fork;
  if (f && f.path === dir && f === k.last) {
    const old = f.kids.find((x) => x.path === a.path) ?? f.hid.find((x) => x.path === a.path);
    if (old) {
      if (old.acts.length < ACTS_MAX) old.acts.push(a);
      return false;
    }
    leaf(s, k, f, a);
    return s.end !== end;
  }
  // A new visit: the folder stop, with room for its first file on the row above (on the ceiling, files only count).
  const nf = stop(s, k, 'fork', a.t, dir, a.id, 2);
  if (!nf) return fold(k, kind, a.t, a.path, a, null), s.end !== end;
  k.fork = nf;
  leaf(s, k, nf, a);
  return s.end !== end;
}

// A file takes the next row above its folder while rows and the folder's share last; else it only counts.
function leaf(s: Story, k: Stack, f: Node, a: Action) {
  if (f.top || f.kids.length >= SHOW || k.r > maxRow(k) || s.nodes.length >= NODES_MAX) {
    if (f.hid.length < HIDDEN_MAX) f.hid.push(loose('file', k.who, a.t, a.path, a, null));
    return;
  }
  const n = put(s, k, 'file', a.t, a.path, { x: f.x + 30 + 8 * f.kids.length, y: rowY(k, k.r), r: k.r, skip: NaN, top: false }, 2);
  n.fork = f;
  n.acts.push(a);
  f.kids.push(n);
}

// A question or error card at the station, as a stop on the main agent's trunk.
export function addCard(s: Story, row: Row) {
  const k = s.stacks.get('main') ?? mainStack(s);
  const end = s.end, kind = row.kind === 'needs' ? 'needs' : 'fault';
  k.fork = null;
  const n = stop(s, k, kind, row.t, row.label, row.key, 1);
  if (!n) fold(k, kind, row.t, row.label, null, row);
  else n.row = row;
  return s.end !== end;
}

function mainStack(s: Story) {
  const k: Stack = { who: 'main', sub: false, x0: MAIN_X0, y0: MAIN_Y0, ceil: MAIN_CEIL, r: 0, last: null, fork: null, over: null, pack: null, wall: Infinity, topX: -Infinity };
  s.stacks.set('main', k);
  return k;
}

// The right limit for a stack's labels, relative to the station.
export const wallOf = (s: Story, who: string) => s.stacks.get(who)?.wall ?? Infinity;

// How far right a stack may still reach: its wall, or room ahead of its newest stop.
const reachOf = (k: Stack) => Math.min(k.wall, (k.last ? k.last.x : k.x0) + ROOM_FWD);

// A subagent started here: a low box in a new column right of everything so far, its line climbing from the box.
export function addBox(s: Story, lane: Lane) {
  const aid = lane.row.aid;
  if (!aid || s.stacks.has(aid)) return false;
  // The main agent's column comes first, so the station's own work sits next to it.
  if (!s.stacks.has('main')) mainStack(s);
  let x = s.end;
  for (const k of s.stacks.values()) x = Math.max(x, reachOf(k));
  x += 16;
  for (const k of s.stacks.values()) k.wall = Math.min(k.wall, x - 12);
  const i = s.boxes.length, y = BOX_Y[i % BOX_Y.length];
  const k: Stack = { who: aid, sub: true, x0: x + BOX_HALF, y0: y - BOX_HALF - 24, ceil: SUB_CEIL, r: 0, last: null, fork: null, over: null, pack: null, wall: Infinity, topX: -Infinity };
  s.stacks.set(aid, k);
  s.boxes.push({ lane, i, t: lane.row.t, x, y });
  s.end = Math.max(s.end, x + 2 * BOX_HALF + 8 + LABEL_W);
  s.top = Math.min(s.top, y - BOX_HALF);
  return true;
}

// The floor this station's tree needs on its right; the same before and after freeze().
export function reach(s: Story) {
  let x = s.end;
  for (const k of s.stacks.values()) x = Math.max(x, reachOf(k));
  return x;
}

// He walked on: every line keeps only the room reach() promised, so it never runs into the next station.
export function freeze(s: Story) {
  for (const k of s.stacks.values()) k.wall = reachOf(k);
}
