import type { Action, Row } from './model.ts';
import type { Lane } from './lanes.ts';

// Watch mode's story tree: what each agent did at a station, as folder visits and leaves in the order it happened.
// An append-only grid of columns and rows, so a new leaf never moves one already standing; world.ts draws it at T.

// Rows per column, and in a column that starts under the station's title.
export const ROWS = 15;
export const ROWS_LOW = 8;
// Column widths in world units, and the first column's offset right of the station.
export const COL_MAIN = 290;
export const COL_SUB = 270;
export const TREE_X0 = 130;
const TITLE_END = 180;
// A subagent's box sits high in its column, above the stage top when needed (the camera zooms out for it), with
// neighbours several rows apart so the stagger reads at a glance.
const BOX_ROW = [21, 14, 19, 12];
export const boxRow = (i: number) => BOX_ROW[i % BOX_ROW.length];
// The main agent's rows rise from the floor; a subagent's run down from below its box toward the floor.
export const slotRow = (C: Col, slot: number) => (C.rb < 0 ? slot : C.rb - 2 - slot);
const capOf = (C: Col) => (C.rb < 0 ? C.rows : C.rb - 1);
// Leaves a folder visit shows before the rest fold into "+k files"; columns the main agent may fill.
const SHOW = 4;
const MAIN_COLS = 4;
// Quiet calls (commands, searches, tools) in a row share one summary line; it lists at most this many.
const GROUP_MAX = 200;
const NODES_MAX = 600;
const ACTS_MAX = 24;
const HIDDEN_MAX = 200;

export type NodeKind = 'fork' | 'file' | 'run' | 'search' | 'other' | 'agent' | 'needs' | 'fault' | 'more' | 'calls';
export type Node = {
  kind: NodeKind; who: string; c: number; r: number; depth: 1 | 2; t: number;
  // A file's path, a folder, or the label of a call or card.
  path: string;
  // The calls behind it (a file read then edited in one visit has several); a question or error card's row.
  acts: Action[]; row: Row | null;
  // The folder visit a leaf hangs from; the row its edge leaves from (-1: the column's base).
  fork: Node | null; prev: number;
  // A visit's shown leaves and its "+k" node; a "+k" node's folded leaves.
  kids: Node[]; more: Node | null; hid: Node[];
};
// used counts slots taken; rb is a subagent column's box row (-1 for the main agent's columns).
export type Col = { who: string; x: number; w: number; rows: number; used: number; sub: boolean; rb: number };
export type Box = { lane: Lane; c: number; i: number; t: number };
// pack: the last quiet call on the stack's newest row, while more can join it.
type Stack = { who: string; c: number; top: number; fork: Node | null; over: Node | null; cols: number; sub: boolean; pack: Node | null };
// end: the right edge of the last column, relative to the station; 0 while it is empty.
export type Story = { cols: Col[]; nodes: Node[]; boxes: Box[]; stacks: Map<string, Stack>; end: number };

export const newStory = (): Story => ({ cols: [], nodes: [], boxes: [], stacks: new Map(), end: 0 });

// "web/src/watch/model.ts" → "web/src/watch/"; a file at the root is in "./".
export const folderOf = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? './' : p.slice(0, i + 1);
};
export const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;

const kindOf = (verb: string): NodeKind =>
  verb === 'read' || verb === 'edit' || verb === 'write' ? 'file'
  : verb === 'run' || verb === 'background' ? 'run'
  : verb === 'search' || verb === 'web' ? 'search'
  : verb === 'agent' ? 'agent'
  : 'other';

// A summary line of quiet calls; a named check keeps its own row and label.
export const quiet = (n: Node) => n.kind === 'calls';

function newCol(s: Story, who: string, sub: boolean, rb = -1) {
  const x = s.end || TREE_X0;
  const w = sub ? COL_SUB : COL_MAIN;
  s.cols.push({ who, x, w, rows: x < TITLE_END ? ROWS_LOW : ROWS, used: 0, sub, rb });
  s.end = x + w;
  return s.cols.length - 1;
}

const blank = (kind: NodeKind, who: string, c: number, r: number, depth: 1 | 2, t: number, path: string, prev: number): Node =>
  ({ kind, who, c, r, depth, t, path, acts: [], row: null, fork: null, prev, kids: [], more: null, hid: [] });

function node(s: Story, k: Stack, kind: NodeKind, depth: 1 | 2, t: number, path: string, prev: number): Node {
  const C = s.cols[k.c];
  const n = blank(kind, k.who, k.c, slotRow(C, C.used++), depth, t, path, prev);
  s.nodes.push(n);
  if (depth === 1) k.pack = null;
  return n;
}

// Room for `need` more slots in the stack's column, opening a new main column when it is full; false: fold the rest.
function room(s: Story, k: Stack, need: number) {
  const C = s.cols[k.c];
  // A stack's last column keeps its last slot for the "+k more" node.
  const last = k.sub || k.cols >= MAIN_COLS;
  if (C.used + need <= capOf(C) - (last ? 1 : 0)) return true;
  if (k.sub || k.cols >= MAIN_COLS) return false;
  k.c = newCol(s, k.who, false);
  k.cols++;
  k.top = -1;
  k.fork = null;
  k.pack = null;
  return true;
}

// Past its last slot, a stack's leaves fold into one "+k more" node.
function fold(s: Story, k: Stack, kind: NodeKind, t: number, path: string, a: Action | null, row: Row | null) {
  if (!k.over) {
    k.fork = null;
    k.over = node(s, k, 'more', 1, t, '', k.top);
    k.top = k.over.r;
  }
  if (k.over.hid.length < HIDDEN_MAX) k.over.hid.push(loose(kind, k.who, t, path, a, row));
}

const loose = (kind: NodeKind, who: string, t: number, path: string, a: Action | null, row: Row | null): Node =>
  Object.assign(blank(kind, who, -1, -1, 2, t, path, -1), { acts: a ? [a] : [], row });

// Returns whether the tree got wider, so the floor after the station can make room.
export function addAct(s: Story, who: string, a: Action) {
  const k = s.stacks.get(who) ?? (who === 'main' ? mainStack(s) : null);
  if (!k || s.nodes.length >= NODES_MAX) return false;
  const cols = s.cols.length, kind = kindOf(a.verb);
  if (k.over) {
    fold(s, k, kind, a.t, kind === 'file' ? a.path : a.label, a, null);
    return false;
  }
  if (kind !== 'file') {
    k.fork = null;
    const p = k.pack, hush = !(kind === 'run' && a.check);
    // Consecutive quiet calls share one summary line ("6 commands · 2 failed").
    if (hush && p && p.c === k.c && p.r === k.top) {
      if (p.acts.length < GROUP_MAX) p.acts.push(a);
      return false;
    }
    if (!room(s, k, 1)) fold(s, k, kind, a.t, a.label, a, null);
    else {
      const n = node(s, k, hush ? 'calls' : kind, 1, a.t, a.label, k.top);
      n.acts.push(a);
      k.top = n.r;
      if (hush) k.pack = n;
    }
    return s.cols.length !== cols;
  }
  const dir = folderOf(a.path);
  const f = k.fork;
  if (f && f.path === dir) {
    const old = f.kids.find((x) => x.path === a.path) ?? f.more?.hid.find((x) => x.path === a.path);
    if (old) {
      if (old.acts.length < ACTS_MAX) old.acts.push(a);
      return false;
    }
    if (f.more) {
      if (f.more.hid.length < HIDDEN_MAX) f.more.hid.push(loose('file', who, a.t, a.path, a, null));
      return false;
    }
    // room() may open a new column instead, and then the visit starts over there.
    if (room(s, k, 1) && k.fork === f) {
      if (f.kids.length < SHOW) leaf(s, k, f, a);
      else {
        f.more = node(s, k, 'more', 2, a.t, dir, f.kids[f.kids.length - 1].r);
        f.more.fork = f;
        f.more.hid.push(loose('file', who, a.t, a.path, a, null));
      }
      return s.cols.length !== cols;
    }
  }
  // A new visit: the folder node and its first leaf.
  if (!room(s, k, 2)) return fold(s, k, kind, a.t, a.path, a, null), s.cols.length !== cols;
  const nf = node(s, k, 'fork', 1, a.t, dir, k.top);
  k.top = nf.r;
  k.fork = nf;
  leaf(s, k, nf, a);
  return s.cols.length !== cols;
}

function leaf(s: Story, k: Stack, f: Node, a: Action) {
  const last = f.kids[f.kids.length - 1];
  const n = node(s, k, 'file', 2, a.t, a.path, last ? last.r : f.r);
  n.fork = f;
  n.acts.push(a);
  f.kids.push(n);
}

// A question or error card at the station, as a leaf on the main agent's trunk.
export function addCard(s: Story, row: Row) {
  const k = s.stacks.get('main') ?? mainStack(s);
  if (s.nodes.length >= NODES_MAX) return false;
  const cols = s.cols.length, kind = row.kind === 'needs' ? 'needs' : 'fault';
  if (k.over || !room(s, k, 1)) return fold(s, k, kind, row.t, row.label, null, row), s.cols.length !== cols;
  k.fork = null;
  const n = node(s, k, kind, 1, row.t, row.label, k.top);
  n.row = row;
  k.top = n.r;
  return s.cols.length !== cols;
}

function mainStack(s: Story) {
  const k: Stack = { who: 'main', c: newCol(s, 'main', false), top: -1, fork: null, over: null, cols: 1, sub: false, pack: null };
  s.stacks.set('main', k);
  return k;
}

// A subagent started here: its own column, its box at the top, its work running down from it.
export function addBox(s: Story, lane: Lane) {
  const aid = lane.row.aid;
  if (!aid || s.stacks.has(aid)) return false;
  // The main agent's column comes first, so the station's own work sits next to it.
  if (!s.stacks.has('main')) mainStack(s);
  const c = newCol(s, aid, true, boxRow(s.boxes.length));
  s.stacks.set(aid, { who: aid, c, top: -1, fork: null, over: null, cols: 1, sub: true, pack: null });
  s.boxes.push({ lane, c, i: s.boxes.length, t: lane.row.t });
  return true;
}
