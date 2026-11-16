import { noteLabel, type ServerEvent, type TimedEvent } from '../protocol.ts';
import { PLUMBING, ToolLog } from '../tools.ts';
import { Chapters } from '../chapters.ts';
import { tuning } from '../profile.ts';
import { NOTE_START, oneLine, wakeOfNote } from '../text.ts';
import { readOrigin } from '../sessionOrigin.ts';
import { TOOL_SERVERS } from '../mcpHost.ts';
import { PANEL_SERVERS } from '../mcp.ts';
import { changeDetail } from '../codex/agents.ts';
import { opencode, type FileDiff, type Message } from './client.ts';

type ToolEvent = Extract<ServerEvent, { type: 'tool' }>;
type Obj = Record<string, unknown>;

const PAGE = 200;
// Older messages load in one go when the reader scrolls past the seeded ones; this bounds a runaway cursor.
const PAGES_MAX = 200;

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

// The app's servers on a tab register as `tarcsweb_<tab key>_<server>`; longest first so no name shadows a longer one.
const SERVERS = [...TOOL_SERVERS, ...Object.values(PANEL_SERVERS)].sort((a, b) => b.length - a.length);
const OWN = /^tarcsweb_[a-z0-9]+_(.+)$/;

// An OpenCode tool name read back as the app's mcp__<server>__<tool>; null for any other tool.
export function appToolName(name: string): string | null {
  const rest = OWN.exec(name)?.[1];
  const server = rest && SERVERS.find((s) => rest.startsWith(`${s}_`));
  return server ? `mcp__${server}__${rest.slice(server.length + 1)}` : null;
}

// OpenCode todos in the shape Claude's TodoWrite and the Work panel read; a cancelled item counts as settled.
export const todosOf = (v: unknown) =>
  (Array.isArray(v) ? v : []).map((t) => ({ content: str(obj(t).content), status: str(obj(t).status) === 'cancelled' ? 'completed' : str(obj(t).status) || 'pending' }));

// OpenCode's native tools as the cards a Claude tab draws for the same work; other tools keep their name under opencode.
export function nativeCall(name: string, input: Obj): { name: string; input: Obj } {
  switch (name) {
    case 'shell': return { name: 'Bash', input: { command: input.command, description: input.description, ...(input.background === true ? { run_in_background: true } : {}) } };
    case 'read': return { name: 'Read', input: { file_path: input.path, offset: input.offset, limit: input.limit } };
    case 'glob': return { name: 'Glob', input: { pattern: input.pattern, path: input.path } };
    case 'grep': return { name: 'Grep', input: { pattern: input.pattern, path: input.path, glob: input.include } };
    case 'edit': return { name: 'Edit', input: { file_path: input.path, old_string: input.oldString, new_string: input.newString, replace_all: input.replaceAll } };
    case 'write': return { name: 'Write', input: { file_path: input.path, content: input.content } };
    case 'webfetch': return { name: 'WebFetch', input: { url: input.url } };
    case 'websearch': return { name: 'WebSearch', input: { query: input.query } };
    case 'todowrite': return { name: 'TodoWrite', input: { todos: todosOf(input.todos) } };
    case 'skill': return { name: 'Skill', input: { skill: input.name ?? input.skill ?? input.id } };
    default: return { name: appToolName(name) ?? `mcp__opencode__${name}`, input };
  }
}

// A patch call has no single input path, so its cards come from the files it changed, one per file.
export function patchCards(cwd: string, id: string, files: FileDiff[]): ToolEvent[] {
  return files.map((f, i) => {
    const detail = changeDetail(cwd, { path: f.file, kind: f.status === 'added' ? { type: 'add' } : f.status === 'deleted' ? { type: 'delete' } : { type: 'update', move_path: null }, diff: f.patch });
    const write = f.status === 'added';
    return { type: 'tool', id: `${id}:${i}`, name: write ? 'Write' : 'Edit', verb: write ? 'write' : 'edit', summary: detail.path, detail };
  });
}

export const diffsOf = (metadata: unknown): FileDiff[] =>
  (Array.isArray(obj(metadata).files) ? (obj(metadata).files as unknown[]) : []).map(obj).filter((f) => typeof f.file === 'string' && typeof f.patch === 'string') as FileDiff[];

// OpenCode can call a shell run that exited non-zero a success; the card should still read as failed.
export const shellFailed = (metadata: unknown) => {
  const exit = obj(metadata).exit;
  return typeof exit === 'number' && exit !== 0;
};

// What the app adds to a prompt: a replay block ahead of the user's text and the turn note after it.
const REPLAY_BLOCK = /^<(earlier-conversation-[\w-]+)>[\s\S]*?<\/\1>\s*/;
export const TURN_OPEN = '<tarcsweb_turn>';
export function userText(text: string) {
  const i = text.lastIndexOf(`\n\n${TURN_OPEN}`);
  const own = i >= 0 && text.trimEnd().endsWith('</tarcsweb_turn>') ? text.slice(0, i) : text.startsWith(TURN_OPEN) ? '' : text;
  return own.replace(REPLAY_BLOCK, '');
}

// Messages, oldest first, as the events a live tab emits, plus the chapters and tool memory they build.
function eventsOf(messages: Message[], cwd: string, chapters: Chapters, tools: ToolLog): TimedEvent[] {
  const out: TimedEvent[] = [];
  for (const m of messages) {
    const at = m.time?.created ?? null;
    const put = (e: ServerEvent, when: number | null = at) => out.push(when === null ? e : { ...e, at: when });
    if (m.type === 'user') {
      const decoded = readOrigin(userText(str(m.text)));
      const text = decoded.text;
      if (!text.trim()) continue;
      const id = `oc:${m.id}`;
      // An agent's report reads as an update header, as on the other providers.
      if (NOTE_START.test(text)) {
        const w = wakeOfNote(text);
        put({ type: 'wake', id: `wake:${id}`, from: w ? [w] : [] });
        continue;
      }
      put({ type: 'user', id, ...decoded });
      if (chapters.size) chapters.end(at);
      chapters.start(id, noteLabel(text) ?? text, at);
      continue;
    }
    if (m.type === 'idle') {
      const e = obj(m.error);
      if (m.outcome === 'failed' && e.message) put({ type: 'error', message: `OpenCode: ${oneLine(str(e.message), 400)}` });
      continue;
    }
    if (m.type !== 'assistant' || !Array.isArray(m.content)) continue;
    m.content.forEach((c, i) => {
      if (c.type === 'text' && c.text) {
        put({ type: 'text', id: `oc:${m.id}:${i}`, delta: c.text });
        chapters.text(c.text + '\n');
        return;
      }
      if (c.type !== 'tool') return;
      const state = obj(c.state);
      const time = obj(c.time);
      const start = typeof time.created === 'number' ? time.created : at;
      const end = typeof time.completed === 'number' ? time.completed : start;
      const id = `oc:${str(c.id)}`;
      const name = str(c.name);
      const failed = state.status === 'error';
      const input = obj(state.input);
      const content = state.content ?? (failed ? [{ type: 'text', text: str(obj(state.error).message) || 'Failed' }] : []);
      if (name === 'patch') {
        const cards = patchCards(cwd, id, diffsOf(state.metadata));
        for (const e of cards) {
          chapters.tool();
          put(e, start);
          put({ type: 'tool-result', id: e.id, error: failed ? 'Failed' : null }, end);
          if (!failed && e.detail?.kind === 'diff') chapters.edited(e.detail.path, e.detail.add, e.detail.rm);
        }
        return;
      }
      const call = nativeCall(name, input);
      if (!PLUMBING.has(call.name)) chapters.tool();
      const ev = tools.call(id, call.name, call.input);
      if (ev) put(ev, start);
      if (state.status !== 'completed' && !failed) return;
      const res = tools.result(id, content, failed || (call.name === 'Bash' && shellFailed(state.metadata)));
      if (res) put(res, end);
      if (!failed && (name === 'edit' || name === 'write')) {
        for (const f of diffsOf(state.metadata)) {
          const d = changeDetail(cwd, { path: f.file, kind: { type: 'update', move_path: null }, diff: f.patch });
          chapters.edited(d.path, d.add, d.rm);
        }
      }
    });
  }
  return out;
}

async function page(id: string, cursor: string | undefined) {
  // A cursor carries its own order, and OpenCode refuses both together.
  return opencode.listMessages(id, cursor ? { limit: PAGE, cursor } : { order: 'desc', limit: PAGE });
}

// OpenCode returns a next cursor even on the last page, so a short page ends the listing.
const more = (p: { data: unknown[]; cursor: { next?: string } }) => (p.data.length < PAGE ? undefined : p.cursor.next);

// A saved session's newest messages as events, enough to fill the in-memory log; `earlier` loads the rest on request.
export async function opencodeHistory(id: string, cwd: string) {
  const newest: Message[] = [];
  let cursor: string | undefined;
  do {
    const p = await page(id, cursor);
    newest.push(...p.data);
    cursor = more(p);
  } while (cursor && newest.length < tuning().logKeep);
  const chapters = new Chapters();
  const tools = new ToolLog(cwd);
  const events = eventsOf(newest.reverse(), cwd, chapters, tools);
  chapters.end(newest[newest.length - 1]?.time?.completed ?? null);
  const from = cursor;
  const earlier = from
    ? async () => {
        const older: Message[] = [];
        let c: string | undefined = from;
        for (let n = 0; c && n < PAGES_MAX; n++) {
          const p = await page(id, c);
          older.push(...p.data);
          c = more(p);
        }
        return eventsOf(older.reverse(), cwd, new Chapters(), new ToolLog(cwd));
      }
    : null;
  return { events, chapters, tools, earlier };
}
