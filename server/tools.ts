import { homedir } from 'node:os';
import type {
  Align, ChartSpec, ChartType, ChoiceSpec, DiffDetail, DiffLine, PlanSpec, RichDetail, RoundPick, RoundSpec, ServerEvent, StepStatus, TableSpec,
} from './protocol.ts';
import { displayPath, oneLine } from './text.ts';
import { imageUrl, localUrls } from './files.ts';

export const PROGRESS_TOOL = 'mcp__agents-panel__progress';
export const VISUAL_TOOL = 'mcp__visual__render_ui';
export const REPLAY_TOOL = 'mcp__replay__open';
export const APP_TOOLS = {
  chart: 'mcp__app__show_chart',
  table: 'mcp__app__show_table',
  plan: 'mcp__app__show_plan',
  choice: 'mcp__app__ask_choice',
  round: 'mcp__app__ask_round',
} as const;
const RICH = new Set<string>([VISUAL_TOOL, REPLAY_TOOL, ...Object.values(APP_TOOLS)]);
// Inputs worth streaming: these build up on screen while the model writes them.
export const STREAMED = new Set<string>([APP_TOOLS.chart, APP_TOOLS.table, APP_TOOLS.plan, VISUAL_TOOL]);
export const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

const DIFF_MAX = 400;
const LINE_MAX = 400;
const CONTEXT = 2;

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
};
// How ask_choice reports a typed answer instead of a picked option.
export const OWN_WORDS = 'The user answered in their own words: ';

// ask_round's handler finds its tool_use by the question titles.
export const roundKey = (input: unknown) => arr(obj(input).questions).map((q) => str(obj(q).title)).join('\n');

type RoundInput = { questions: { title: string; options: { label: string }[] }[] };
const UNANSWERED = 'unanswered — ask again next round if it still matters';
const ROUND_LINE = /^Q(\d+) .*?: (?:option (\d+) ".*?"(?: — note: (.*))?|own words: (.*)|unanswered — .*)$/;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

// What ask_round returns to the model, one line per question; roundPicks reads it back for the card.
export function roundText(input: RoundInput, picks: RoundPick[]) {
  let skipped = 0;
  const lines = input.questions.map((q, i) => {
    const p = picks[i];
    const note = flat(p?.note ?? '');
    const head = `Q${i + 1} ${flat(q.title)}: `;
    if (p && p.option !== null) return `${head}option ${p.option + 1} "${flat(q.options[p.option]?.label ?? '')}"${note ? ` — note: ${note}` : ''}`;
    if (note) return `${head}own words: ${note}`;
    skipped++;
    return head + UNANSWERED;
  });
  const tail = skipped ? ['Do not decide the unanswered ones for the user.'] : [];
  return ['The user submitted the round:', ...lines, ...tail].join('\n');
}

function roundPicks(text: string): RoundPick[] {
  const out: RoundPick[] = [];
  for (const line of text.split('\n')) {
    const m = ROUND_LINE.exec(line);
    if (m) out[Number(m[1]) - 1] = { option: m[2] ? Number(m[2]) - 1 : null, note: m[3] ?? m[4] ?? '' };
  }
  return Array.from(out, (p) => p ?? { option: null, note: '' });
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Absolute paths inside text (a shell command) shown relative to the session folder, and home as ~.
export function relText(cwd: string, text: string) {
  const home = homedir();
  let out = text.split(cwd + '/').join('');
  out = out.replace(new RegExp(`${escRe(cwd)}(?=$|[\\s'"):;])`, 'g'), '.');
  return home ? out.split(home + '/').join('~/') : out;
}

// One line describing a call, with paths relative to the session folder.
export function summarizeFor(cwd: string, name: string, input: unknown): string {
  const o = obj(input);
  const path = str(o.file_path) || str(o.notebook_path);
  if (path) return displayPath(cwd, path);
  if (name === 'Grep' || name === 'Glob') {
    const where = str(o.path) ? ` in ${displayPath(cwd, str(o.path))}` : '';
    return oneLine(`${str(o.pattern)}${where}`);
  }
  // "cd <session folder> && " is noise once paths are shown relative to that folder.
  if (name === 'Bash') return oneLine(relText(cwd, str(o.command)).replace(/^cd \.\s*&&\s*/, ''));
  if (name === VISUAL_TOOL) return oneLine(str(o.title) || 'Visual');
  if (name === APP_TOOLS.choice) return oneLine(str(o.question));
  if (name === APP_TOOLS.round) return oneLine(str(o.title) || arr(o.questions).map((q) => str(obj(q).title)).join(' · '));
  if (name === APP_TOOLS.chart || name === APP_TOOLS.table || name === APP_TOOLS.plan) return oneLine(str(o.title));
  for (const key of ['command', 'path', 'url', 'query', 'description', 'prompt', 'skill']) {
    if (typeof o[key] === 'string') return oneLine(relText(cwd, o[key] as string));
  }
  const first = Object.values(o).find((v) => typeof v === 'string');
  return typeof first === 'string' ? oneLine(relText(cwd, first)) : '';
}

// Tools that only load schemas or report progress; never shown as work.
export const PLUMBING = new Set([PROGRESS_TOOL, 'ToolSearch']);

const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// "Navigate · claude-in-chrome" for an MCP tool, so raw mcp__ ids never reach the screen.
export function toolName(name: string) {
  if (!name.startsWith('mcp__')) return name;
  const [, server = '', ...rest] = name.split('__');
  const tool = words(rest.join(' '));
  return tool ? `${cap(tool)} · ${server}` : server;
}

const NAMED: Record<string, string> = {
  [APP_TOOLS.chart]: 'Drawing a chart', [APP_TOOLS.table]: 'Showing a table', [APP_TOOLS.plan]: 'Updating the plan',
  [APP_TOOLS.choice]: 'Asking you a question', [APP_TOOLS.round]: 'Asking you a few questions', [VISUAL_TOOL]: 'Drawing a visual', [REPLAY_TOOL]: 'Opening a replay',
  TodoWrite: 'Updating the plan', ExitPlanMode: 'Presenting a plan', AskUserQuestion: 'Asking you a question',
  BashOutput: 'Reading process output', KillShell: 'Stopping a process', TaskStop: 'Stopping a process',
};

// "Reading src/App.tsx", "Running pnpm test": a call as one present-tense line.
export function describeTool(cwd: string, name: string, input: unknown): string {
  if (NAMED[name]) return NAMED[name];
  const o = obj(input);
  const path = str(o.file_path) || str(o.notebook_path);
  if (name === 'Read' && path) return `Reading ${displayPath(cwd, path)}`;
  if (name === 'Write' && path) return `Writing ${displayPath(cwd, path)}`;
  if (EDIT_TOOLS.test(name) && path) return `Editing ${displayPath(cwd, path)}`;
  if (name === 'Bash') return `Running ${oneLine(summarizeFor(cwd, name, o), 80)}`;
  if (name === 'Grep' || name === 'Glob') return `Searching for ${oneLine(str(o.pattern), 60)}`;
  if (name === 'WebSearch') return `Searching the web for ${oneLine(str(o.query), 60)}`;
  if (name === 'WebFetch') return `Fetching ${oneLine(str(o.url).replace(/^https?:\/\//, ''), 60)}`;
  if (name === 'Agent' || name === 'Task') return `Starting an agent: ${oneLine(str(o.description) || str(o.subagent_type) || 'agent', 60)}`;
  if (name === 'Skill') return `Using the ${oneLine(str(o.skill), 40)} skill`;
  const label = name.startsWith('mcp__') ? cap(words(name.split('__').slice(2).join(' ')) || toolName(name)) : name;
  return oneLine(`${label} ${summarizeFor(cwd, name, o)}`.trim(), 90);
}

// The short label a tool row starts with: "read", "edit", "run".
export function verbOf(name: string) {
  if (name === 'Read') return 'read';
  if (name === 'Write') return 'write';
  if (EDIT_TOOLS.test(name)) return 'edit';
  if (name === 'Bash' || name === 'BashOutput') return 'run';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'WebFetch') return 'fetch';
  if (name === 'WebSearch') return 'web';
  if (name === 'Agent' || name === 'Task') return 'agent';
  if (name === 'TodoWrite') return 'todo';
  const short = name.startsWith('mcp__') ? name.split('__').pop() || name : name;
  return short.toLowerCase().replace(/_/g, ' ').slice(0, 16);
}

const lines = (s: string) => (s ? s.replace(/\n$/, '').split('\n') : []);
const cut = (s: string) => (s.length > LINE_MAX ? s.slice(0, LINE_MAX) + '…' : s);

// Changed lines of one replacement, with a little unchanged context around them.
function hunk(before: string, after: string, out: DiffLine[]) {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  for (const l of a.slice(Math.max(0, start - CONTEXT), start)) out.push([' ', l]);
  for (const l of a.slice(start, a.length - end)) out.push(['-', l]);
  for (const l of b.slice(start, b.length - end)) out.push(['+', l]);
  for (const l of a.slice(a.length - end, a.length - end + CONTEXT)) out.push([' ', l]);
}

// The diff a file tool call would make, computed from its input alone.
export function diffDetail(cwd: string, name: string, input: unknown): DiffDetail | null {
  const o = obj(input);
  const path = str(o.file_path) || str(o.notebook_path);
  if (!path || !EDIT_TOOLS.test(name)) return null;
  const all: DiffLine[] = [];
  if (name === 'Edit') hunk(str(o.old_string), str(o.new_string), all);
  else if (name === 'MultiEdit') {
    arr(o.edits).forEach((e, i) => {
      if (i > 0) all.push([' ', '⋯']);
      hunk(str(obj(e).old_string), str(obj(e).new_string), all);
    });
  } else if (name === 'Write') for (const l of lines(str(o.content))) all.push(['+', l]);
  else if (o.edit_mode === 'delete') all.push(['-', '(cell deleted)']);
  else for (const l of lines(str(o.new_source))) all.push(['+', l]);
  const add = all.filter((l) => l[0] === '+').length;
  const rm = all.filter((l) => l[0] === '-').length;
  const shown = all.slice(0, DIFF_MAX).map(([k, t]) => [k, cut(t)] as DiffLine);
  return { kind: 'diff', path: displayPath(cwd, path), add, rm, lines: shown, more: all.length - shown.length, created: name === 'Write' };
}

const CHART_TYPES: ChartType[] = ['bar', 'line', 'area', 'stat'];
const toNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

function chartSpec(o: Obj): ChartSpec {
  return {
    type: CHART_TYPES.includes(o.type as ChartType) ? (o.type as ChartType) : 'bar',
    title: oneLine(str(o.title), 120),
    unit: oneLine(str(o.unit), 24),
    labels: arr(o.labels).slice(0, 60).map((l) => oneLine(String(l ?? ''), 60)),
    series: arr(o.series).slice(0, 4).map((s) => ({
      name: oneLine(str(obj(s).name), 40),
      values: arr(obj(s).values).slice(0, 60).map(toNum).filter(Number.isFinite),
    })),
  };
}

function tableSpec(o: Obj): TableSpec {
  const cell = (c: unknown) => (c === null || c === undefined ? '' : typeof c === 'object' ? JSON.stringify(c) : String(c)).slice(0, 300);
  return {
    title: oneLine(str(o.title), 120),
    note: oneLine(str(o.note), 80),
    columns: arr(o.columns).slice(0, 12).map(cell),
    rows: arr(o.rows).slice(0, 200).map((r) => arr(r).slice(0, 12).map(cell)),
    align: arr(o.align).slice(0, 12).map((a) => (a === 'right' || a === 'center' ? a : 'left') as Align),
  };
}

function planSpec(o: Obj): PlanSpec {
  const ok = (s: unknown): StepStatus => (s === 'doing' || s === 'done' ? s : 'todo');
  return {
    title: oneLine(str(o.title), 120),
    steps: arr(o.steps).slice(0, 30).map((s) => ({ text: oneLine(str(obj(s).text), 200), status: ok(obj(s).status) })),
  };
}

// TodoWrite's list in show_plan's shape; the step text is `content`, which stays the same as a step's status moves.
function todoSpec(o: Obj): PlanSpec | null {
  const status = (s: unknown): StepStatus => (s === 'completed' ? 'done' : s === 'in_progress' ? 'doing' : 'todo');
  const steps = arr(o.todos).slice(0, 30).flatMap((t) => {
    const text = oneLine(str(obj(t).content), 200);
    return text ? [{ text, status: status(obj(t).status) }] : [];
  });
  return steps.length ? { title: '', steps } : null;
}

// The plan a call carries (show_plan or TodoWrite); null while it has no step.
export function planOf(name: string, input: unknown): PlanSpec | null {
  const plan = name === APP_TOOLS.plan ? planSpec(obj(input)) : name === 'TodoWrite' ? todoSpec(obj(input)) : null;
  return plan?.steps.length ? plan : null;
}

function choiceSpec(o: Obj): ChoiceSpec {
  return {
    question: oneLine(str(o.question), 200),
    options: arr(o.options).slice(0, 6).map((x) => ({ label: oneLine(str(obj(x).label), 80), description: oneLine(str(obj(x).description), 200) })),
  };
}

function roundSpec(o: Obj): RoundSpec {
  const questions = arr(o.questions).slice(0, 5).map((x) => {
    const q = obj(x);
    const options = arr(q.options).slice(0, 4).map((y) => ({ label: oneLine(str(obj(y).label), 80), description: oneLine(str(obj(y).description), 200) }));
    const rec = q.recommended;
    const recommended = typeof rec === 'number' && Number.isInteger(rec) && rec >= 0 && rec < options.length ? rec : null;
    return { title: oneLine(str(q.title), 200), setup: oneLine(str(q.setup), 400), options, recommended, why: oneLine(str(q.why), 400) };
  });
  return { title: oneLine(str(o.title), 120), questions };
}

// The frame a rich tool renders; the mod's own clamps keep the size the same as in the terminal.
function richDetail(name: string, o: Obj, partial: boolean): RichDetail | null {
  switch (name) {
    case VISUAL_TOOL:
      return {
        kind: 'visual', html: partial ? '' : localUrls(str(o.html)), width: Math.ceil(clamp(o.width, 320, 1800, 960) / 9) * 9,
        height: clamp(o.rows, 4, 30, 20) * 19, durationMs: clamp(o.duration_ms, 0, 20000, 0), title: oneLine(str(o.title), 80),
      };
    case REPLAY_TOOL:
      return { kind: 'replay', title: '', page: clamp(o.page, 1, 999, 1) };
    case APP_TOOLS.chart:
      return { kind: 'chart', chart: chartSpec(o) };
    case APP_TOOLS.table:
      return { kind: 'table', table: tableSpec(o) };
    case APP_TOOLS.plan:
      return { kind: 'plan', plan: planSpec(o) };
    case APP_TOOLS.choice:
      return { kind: 'choice', choice: choiceSpec(o) };
    case APP_TOOLS.round:
      return { kind: 'round', round: roundSpec(o) };
  }
  return null;
}

function resultText(content: unknown) {
  if (typeof content === 'string') return content;
  return arr(content).map((b) => str(obj(b).text)).join('\n');
}

// Per-session memory of tool calls, shared by live events and transcript replay.
export class ToolLog {
  private cwd: string;
  private names = new Map<string, string>();
  // render_ui pictures by path, so a later Read of one folds into its frame.
  private pngs = new Map<string, string>();
  private replays = new Map<string, string>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  call(id: string, name: string, input: unknown, partial = false): Extract<ServerEvent, { type: 'tool' }> | null {
    // Plumbing the reader does not need: progress goes to the agents panel, ToolSearch only loads tool schemas.
    if (PLUMBING.has(name)) return null;
    const o = obj(input);
    const summary = summarizeFor(this.cwd, name, o);
    // A background command answers at once; the verb keeps the row from reading as finished.
    const verb = name === 'Bash' && o.run_in_background === true ? 'background' : verbOf(name);
    if (!partial) this.names.set(id, name);
    if (name === 'Read' && this.pngs.has(str(o.file_path))) return { type: 'tool', id, name, verb, summary, fold: this.pngs.get(str(o.file_path)) };
    if (name === REPLAY_TOOL) {
      // The input is tiny, and a partial one cannot tell an open from a check yet.
      if (partial) return null;
      // A check renders pages for the agent's own review; it stays a plain tool row, never a card.
      if (o.check === true) return { type: 'tool', id, name, verb: 'Checking the replay', summary };
      const path = str(o.path);
      // Opening the same manifest again replaces the earlier card instead of stacking a second one.
      const replaces = path ? [...this.replays].findLast(([, p]) => p === path)?.[0] : undefined;
      if (path) this.replays.set(id, path);
      const detail = richDetail(name, o, false);
      return { type: 'tool', id, name, verb, summary, ...(detail ? { detail } : {}), ...(replaces ? { replaces } : {}) };
    }
    // TodoWrite is not streamed; a list without steps stays a plain row instead of an empty plan.
    if (name === 'TodoWrite') {
      const plan = partial ? null : todoSpec(o);
      return { type: 'tool', id, name, verb, summary, ...(plan ? { detail: { kind: 'plan', plan } } : {}) };
    }
    if (RICH.has(name)) {
      const detail = richDetail(name, o, partial);
      return { type: 'tool', id, name, verb, summary, ...(detail ? { detail } : {}), ...(partial ? { partial: true } : {}) };
    }
    const diff = partial ? null : diffDetail(this.cwd, name, o);
    return { type: 'tool', id, name, verb, summary, ...(diff ? { detail: diff } : {}) };
  }

  result(id: string, content: unknown, isError: boolean): Extract<ServerEvent, { type: 'tool-result' }> | null {
    const name = this.names.get(id);
    if (!name) return null;
    const text = resultText(content);
    const error = isError ? oneLine(text.replace(/<\/?tool_use_error>/g, ''), 200) || 'Failed' : null;
    const ev: Extract<ServerEvent, { type: 'tool-result' }> = { type: 'tool-result', id, error };
    if (name === VISUAL_TOOL && !isError) {
      const png = /\bpng: (\/\S+?\.png)/.exec(text)?.[1];
      if (png) {
        this.pngs.set(png, id);
        ev.png = png;
      }
    }
    // Replay page PNGs fold into the replay card too, so the agent's self-check stays out of the transcript.
    if (name === REPLAY_TOOL && !isError) for (const m of text.matchAll(/\bpng (\/\S+?\.png)/g)) this.pngs.set(m[1], id);
    // An image the Read tool returned: cached and served so the transcript can show it.
    if (name === 'Read' && !isError) {
      const b = arr(content).map(obj).find((x) => x.type === 'image');
      const src = obj(b?.source);
      const url = src.type === 'base64' ? imageUrl(str(src.media_type), str(src.data)) : null;
      if (url) ev.img = url;
    }
    if (name === APP_TOOLS.choice) {
      const n = /^The user chose option (\d+)/.exec(text);
      ev.choice = n && !isError ? Number(n[1]) - 1 : null;
      if (!isError && text.startsWith(OWN_WORDS)) ev.answer = text.slice(OWN_WORDS.length);
    }
    if (name === APP_TOOLS.round) ev.round = isError ? null : roundPicks(text);
    return ev;
  }

  replayPath(id: string) {
    return this.replays.get(id) ?? null;
  }
}

// Best-effort parse of a JSON prefix: close what is open, or fall back to the last clean cut.
export function parsePartial(src: string): unknown {
  try {
    return JSON.parse(src);
  } catch {}
  const stack: string[] = [];
  const cuts: { at: number; close: string }[] = [];
  let inStr = false;
  let esc = false;
  const closers = () => stack.slice().reverse().join('');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
      cuts.push({ at: i + 1, close: closers() });
    } else if (c === '}' || c === ']') {
      stack.pop();
      cuts.push({ at: i + 1, close: closers() });
    } else if (c === ',') cuts.push({ at: i, close: closers() });
  }
  const tries = [inStr ? src.replace(/\\$/, '') + '"' + closers() : src + closers(), ...cuts.slice(-4).reverse().map((k) => src.slice(0, k.at) + k.close)];
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  return undefined;
}
