// Turns raw process output into readable rows: levels, fields, tracing-tree spans as groups, repeats folded.
export type Level = 'error' | 'warn' | 'info' | 'debug';
export type Field = { k: string; v: string };
export type LogLine = { kind: 'line'; level: Level | null; msg: string; fields: Field[]; raw: string; count: number };
export type LogGroup = { kind: 'group'; title: string; fields: Field[]; raw: string; children: LogNode[]; count: number; worst: Level | null; last: Field[] };
export type LogNode = LogLine | LogGroup;

const RANK: Record<Level, number> = { error: 3, warn: 2, info: 1, debug: 0 };
const LEVELS: Record<string, Level> = { ERROR: 'error', ERR: 'error', FATAL: 'error', PANIC: 'error', WARN: 'warn', WARNING: 'warn', INFO: 'info', DEBUG: 'debug', TRACE: 'debug' };
// Fields that only describe plumbing; they stay in the raw text.
const NOISE = /(^|\.)kind$|\.system\.name$|^repository\.name$|^code\.|^thread\.|^otel\.(status|library)|^target$|(^|[._])(span_id|trace_id|request_id|uuid|request_uuid)$|user_agent|^http\.route$|^http\.response\.status_code$/;
// More fields than this go to the tooltip; the row stays one line.
const MAX_FIELDS = 4;

export const worse = (a: Level | null, b: Level | null) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);

// pnpm store paths carry a hash per package; the package path after the last node_modules is what matters.
const tidyPaths = (s: string) => s.replace(/(?:\S*\/)?node_modules\/\.pnpm\/\S*?\/node_modules\//g, '').replace(/(\d{4,})ms\b/g, (_, n: string) => `${(Number(n) / 1000).toFixed(1)}s`);

function parseFields(body: string): Field[] {
  const out: Field[] = [];
  for (const m of body.matchAll(/([\w.]+)=("(?:[^"\\]|\\.)*"|[^\s,}]+)/g)) out.push({ k: m[1]!, v: m[2]!.replace(/^"(.*)"$/, '$1') });
  return out;
}

const shown = (fields: Field[]) => fields.filter((f) => !NOISE.test(f.k)).slice(0, MAX_FIELDS);
const cap = (s: string) => (/^[a-z]+(\s|$)/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function parseJson(raw: string): LogLine | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const msg = String(o.msg ?? o.message ?? (o.fields as Record<string, unknown> | undefined)?.message ?? '');
    if (!msg) return null;
    const lv = String(o.level ?? o.lvl ?? o.severity ?? '').toUpperCase();
    const fields = Object.entries(o)
      .filter(([k]) => !/^(msg|message|level|lvl|severity|time|timestamp|ts|fields|v|pid|hostname)$/.test(k))
      .map(([k, v]) => ({ k, v: typeof v === 'string' ? v : JSON.stringify(v) }));
    return { kind: 'line', level: LEVELS[lv] ?? (Number(lv) >= 50 ? 'error' : Number(lv) >= 40 ? 'warn' : null), msg: cap(msg), fields: shown(fields), raw, count: 1 };
  } catch {
    return null;
  }
}

// One event line: optional timestamp, level, target, message and trailing key=value fields.
export function parseLine(raw: string): LogLine {
  const text = raw.trim();
  if (text.startsWith('{')) {
    const j = parseJson(text);
    if (j) return j;
  }
  let rest = text.replace(/^\[?\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?\]?\s*|^\[?\d\d:\d\d:\d\d(?:\.\d+)?\]?\s*/, '');
  let level: Level | null = null;
  // Metro puts the platform first ("Web  WARN  ..."), so one short word may come before an uppercase level.
  const lv = /^(?:[A-Za-z]{1,8}\s+(?=[A-Z]{4,7}\b))?\[?(ERROR|ERR|FATAL|PANIC|WARN|WARNING|INFO|DEBUG|TRACE)\]?:?\s+/i.exec(rest);
  if (lv && (lv[1] === lv[1]!.toUpperCase() || /^(error|warn(ing)?):/i.test(rest))) {
    level = LEVELS[lv[1]!.toUpperCase()]!;
    rest = rest.slice(lv[0].length);
    // A Rust-style target (crate::module) right after the level adds nothing to the message.
    const target = /^[a-z_][a-z0-9_]*(?:::[a-z0-9_]+)*:?\s+/.exec(rest);
    if (target && (target[0].includes('::') || target[0].includes('_'))) rest = rest.slice(target[0].length);
  } else if (/\bpanicked at\b|^Traceback\b|^Uncaught\b|^\s*(?:Error|TypeError|ReferenceError|SyntaxError):/.test(rest)) level = 'error';
  const fields: Field[] = [];
  // Trailing key=value pairs move out of the sentence into fields.
  const tail = /(?:[,\s]+[\w.]+=(?:"(?:[^"\\]|\\.)*"|[^\s,]+))+\s*$/.exec(rest);
  if (tail && tail.index > 0) {
    fields.push(...parseFields(tail[0]));
    rest = rest.slice(0, tail.index).replace(/[,:]\s*$/, '');
  }
  return { kind: 'line', level, msg: cap(tidyPaths(rest)), fields: shown(fields), raw, count: 1 };
}

// A span header like `crate::module::name{a="b", c=1}`: its last path segment, or the otel name when it has one.
function parseSpan(raw: string, head: string): LogGroup {
  const m = /^(.*?)\{(.*)\}\s*$/.exec(head);
  const path = (m ? m[1]! : head).trim();
  const fields = m ? parseFields(m[2]!) : [];
  const otel = fields.find((f) => f.k === 'otel.name')?.v;
  const title = otel ? otel.replace('.', ' · ') : cap(path.split('::').pop()!.replace(/[_.]/g, ' '));
  const rest = shown(fields.filter((f) => f.k !== 'otel.name'));
  // Values that read on their own (GET, spidr) drop their long keys.
  const short = rest.map((f) => (/\.method$|^provider\.name$/.test(f.k) ? { k: '', v: f.v } : f)).filter((f) => !(f.k === '' && otel?.startsWith(f.v)));
  return { kind: 'group', title, fields: short, raw, children: [], count: 1, worst: null, last: [] };
}

// Shape of a node without its changing values, so repeated runs compare equal.
const shape = (n: LogNode): string => (n.kind === 'line' ? `${n.level}|${n.msg.replace(/\d+/g, '#')}` : `${n.title}[${n.children.map(shape).join(',')}]`);

// How far back a repeat is looked for; dev servers print the same few lines on every reload.
const WINDOW = 12;

// A repeat of a recent node moves it to the bottom with a count; the newest values (checked=3) win.
function push(list: LogNode[], n: LogNode) {
  const key = shape(n);
  for (let i = list.length - 1; i >= Math.max(0, list.length - WINDOW); i--) {
    const prev = list[i]!;
    if (shape(prev) !== key) continue;
    list.splice(i, 1);
    const count = prev.count + n.count;
    list.push(n.kind === 'group' && prev.kind === 'group' ? { ...n, count, worst: worse(prev.worst, n.worst) } : { ...n, count });
    return;
  }
  list.push(n);
}

function close(g: LogGroup) {
  for (const c of g.children) g.worst = worse(g.worst, c.kind === 'line' ? c.level : c.worst);
  const end = g.children.findLast((c): c is LogLine => c.kind === 'line' && c.fields.length > 0);
  g.last = end?.fields ?? [];
}

function step(raw: string, root: LogNode[], stack: LogGroup[]) {
  const into = () => stack[stack.length - 1]?.children ?? root;
  const open = /^\s*(?:└─)?┐(.+)$/.exec(raw);
  if (open) {
    stack.push(parseSpan(raw, open[1]!));
    return;
  }
  if (/^\s*(?:┌─)?┘\s*$/.test(raw)) {
    const g = stack.pop();
    if (g) {
      close(g);
      push(into(), g);
    }
    return;
  }
  push(into(), parseLine(raw.replace(/^\s*[├└│]─*\s?/, '')));
}

// A parse that more text can extend. root and stack (spans still open) cover the complete lines in `done`;
// nodes is the result, with the unfinished last line and the open spans folded in on copies.
export type LogParse = { text: string; done: string; cut: boolean; skip: boolean; root: LogNode[]; stack: LogGroup[]; nodes: LogNode[] };

const copyOf = (g: LogGroup): LogGroup => ({ ...g, children: [...g.children] });

// cut: the text is a tail, so its first line is probably a fragment.
// When `text` extends the previous parse's text only the new lines are read; earlier rows keep their identity. prev is never mutated.
export function parseMore(prev: LogParse | null, text: string, cut = false): LogParse {
  const more = prev !== null && prev.cut === cut && text.startsWith(prev.done);
  let skip = more ? prev.skip : cut;
  const root = more ? [...prev.root] : [];
  const stack = more ? prev.stack.map(copyOf) : [];
  const lines = text.slice(more ? prev.done.length : 0).split('\n');
  const partial = lines.pop()!;
  for (const raw of lines) {
    if (skip) skip = false;
    else if (raw.trim()) step(raw, root, stack);
  }
  const nodes = [...root];
  const open = stack.map(copyOf);
  if (!skip && partial.trim()) step(partial, nodes, open);
  // Spans still open at the end of the tail are running now.
  while (open.length) {
    const g = open.pop()!;
    close(g);
    push(open[open.length - 1]?.children ?? nodes, g);
  }
  return { text, done: text.slice(0, text.length - partial.length), cut, skip, root, stack, nodes };
}

// Every event line under the nodes, with the group titles above it.
export function flatLines(nodes: LogNode[], trail: string[] = []): { line: LogLine; trail: string[] }[] {
  return nodes.flatMap((n) => (n.kind === 'line' ? [{ line: n, trail }] : flatLines(n.children, [...trail, n.title])));
}

// The raw text behind a node, repeats noted once instead of copied N times.
export function rawOf(n: LogNode): string {
  const body = n.kind === 'line' ? n.raw : [n.raw, ...n.children.map(rawOf)].join('\n');
  return n.count > 1 ? `${body}\n(repeated ${n.count} times)` : body;
}
