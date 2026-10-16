import { noteLabel, type Attachment, type GenImage, type ServerEvent, type TimedEvent } from '../protocol.ts';
import { CODEX_TOOLS, PLUMBING, ToolLog, relText, summarizeFor, verbOf } from '../tools.ts';
import { Chapters } from '../chapters.ts';
import { LOG_KEEP } from '../coldLog.ts';
import { imageUrl, localImageUrl } from '../files.ts';
import { displayPath, oneLine } from '../text.ts';
import { TOOL_SERVERS } from '../mcpHost.ts';
import { codex } from './client.ts';
import { changeDetail } from './agents.ts';
import { toItem } from './threads.ts';
import type { ThreadItem, Turn, UserInput } from './types.ts';

type ToolEvent = Extract<ServerEvent, { type: 'tool' }>;
type HistoryTurn = Turn & { items: unknown[] };

const TURNS_PAGE = 20;
// Older turns load in one go when the reader scrolls past the seeded ones; this bounds a runaway cursor.
const PAGES_MAX = 500;
const OUTPUT_TAIL = 4000;

// "/usr/bin/zsh -lc 'ls -1'" reads as "ls -1"; Codex wraps every command in the user's login shell.
export const shell = (command: string) => command.replace(/^\S*\/(ba|z)?sh -lc /, '').replace(/^(["'])([\s\S]*)\1$/, '$2');

export const ownTool = (item: ThreadItem) => item.type === 'mcpToolCall' && TOOL_SERVERS.includes(item.server);

// The cards an item opens with, the same live and in history; calls to our own MCP servers go through ToolLog instead.
export function startCards(cwd: string, item: ThreadItem): ToolEvent[] {
  const id = `cx:${item.id}`;
  switch (item.type) {
    case 'commandExecution':
      return [{ type: 'tool', id, name: 'Bash', verb: 'run', summary: oneLine(relText(cwd, shell(item.command))) }];
    case 'fileChange':
      return item.changes.map((c, i) => {
        const write = c.kind.type === 'add';
        const detail = changeDetail(cwd, c);
        return { type: 'tool', id: `${id}:${i}`, name: write ? 'Write' : 'Edit', verb: write ? 'write' : 'edit', summary: detail.path, detail };
      });
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const name = item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : `mcp__${item.namespace ?? 'codex'}__${item.tool}`;
      return [{ type: 'tool', id, name, verb: verbOf(name), summary: summarizeFor(cwd, name, item.arguments) }];
    }
    case 'collabAgentToolCall':
      return [{ type: 'tool', id, name: `codex:${item.tool}`, verb: 'agent', summary: oneLine(item.prompt || item.tool) }];
    case 'imageView':
      return [{ type: 'tool', id, name: 'Read', verb: 'read', summary: displayPath(cwd, item.path) }];
    case 'imageGeneration':
      return [{
        type: 'tool', id, name: CODEX_TOOLS.image, verb: 'image', summary: oneLine(item.revisedPrompt ?? 'Image'),
        detail: { kind: 'image', prompt: oneLine(item.revisedPrompt ?? '', 300), count: 1 },
      }];
    default:
      return [];
  }
}

// How a finished item's cards end: [card id, error or null].
export function endStates(item: ThreadItem): [string, string | null][] {
  const id = `cx:${item.id}`;
  switch (item.type) {
    case 'commandExecution': {
      const out = (item.aggregatedOutput ?? '').slice(-OUTPUT_TAIL).trim();
      const failed = item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0);
      const tail = out ? `: ${oneLine(out.split('\n').pop() ?? '', 160)}` : '';
      return [[id, item.status === 'declined' ? 'Declined' : failed ? `Exit code ${item.exitCode ?? '?'}${tail}` : null]];
    }
    case 'fileChange': {
      const error = item.status === 'completed' ? null : item.status === 'declined' ? 'Declined' : 'Failed';
      return item.changes.map((_, i) => [`${id}:${i}`, error]);
    }
    case 'mcpToolCall':
      return [[id, item.status === 'failed' || item.error ? oneLine(item.error?.message ?? 'Failed', 200) : null]];
    case 'dynamicToolCall':
      return [[id, item.status === 'failed' || item.success === false ? 'Failed' : null]];
    case 'collabAgentToolCall':
      return [[id, item.status === 'failed' ? 'Failed' : null]];
    default:
      return [];
  }
}

// A prompt's text and images as the conversation shows them; images become cached files, never base64 in events.
function promptOf(content: UserInput[]): { text: string; files: Attachment[] } {
  const text: string[] = [];
  const files: Attachment[] = [];
  for (const c of content) {
    if (c.type === 'text') text.push(c.text);
    else if (c.type === 'localImage') files.push({ name: 'Image', kind: 'image', src: localImageUrl(c.path, 0, 0) });
    else {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(c.url);
      const src = m ? imageUrl(m[1], m[2]) : null;
      files.push({ name: 'Image', kind: 'image', ...(src ? { src } : {}) });
    }
  }
  return { text: text.join('\n\n'), files };
}

// Turns, oldest first, as the events a live tab emits, plus the chapters and tool memory they build.
function eventsOf(turns: HistoryTurn[], cwd: string, chapters: Chapters, tools: ToolLog): TimedEvent[] {
  const out: TimedEvent[] = [];
  for (const turn of turns) {
    const at = turn.startedAt ? turn.startedAt * 1000 : null;
    const put = (e: ServerEvent) => out.push(at === null ? e : { ...e, at });
    for (const raw of turn.items) {
      const item = toItem(raw);
      const id = `cx:${item.id}`;
      switch (item.type) {
        case 'userMessage': {
          const { text, files } = promptOf(item.content ?? []);
          if (!text.trim() && !files.length) break;
          put({ type: 'user', id, text, ...(files.length ? { files } : {}) });
          if (chapters.size) chapters.end(at);
          chapters.start(id, text.trim() ? noteLabel(text) ?? text : files.map((f) => f.name).join(', '), at);
          break;
        }
        case 'agentMessage':
          if (!item.text) break;
          put({ type: 'text', id, delta: item.text });
          chapters.text(item.text + '\n');
          break;
        case 'webSearch':
          chapters.tool();
          put({ type: 'tool', id, name: 'WebSearch', verb: 'web', summary: oneLine(item.query || item.action?.query || item.action?.url || 'the web') });
          put({ type: 'tool-result', id, error: null });
          break;
        case 'imageView':
          chapters.tool();
          for (const e of startCards(cwd, item)) put(e);
          put({ type: 'tool-result', id, error: null, img: localImageUrl(item.path, 0, 0) });
          break;
        case 'imageGeneration': {
          chapters.tool();
          for (const e of startCards(cwd, item)) put(e);
          const images: GenImage[] = item.savedPath ? [{ path: item.savedPath, src: localImageUrl(item.savedPath, 0, 0) }] : [];
          put({ type: 'tool-result', id, error: item.failure ? 'Codex hit its image generation limit' : images.length ? null : 'Codex made no image file', ...(images.length ? { images } : {}) });
          break;
        }
        case 'mcpToolCall':
          if (ownTool(item)) {
            const name = `mcp__${item.server}__${item.tool}`;
            if (!PLUMBING.has(name)) chapters.tool();
            const call = tools.call(id, name, item.arguments);
            if (call) put(call);
            const bad = item.status === 'failed' || !!item.error;
            const res = tools.result(id, item.result?.content ?? (item.error?.message ? [{ type: 'text', text: item.error.message }] : []), bad);
            if (res) put(res);
            break;
          }
        // falls through: another server's call shows as a plain card
        case 'commandExecution':
        case 'fileChange':
        case 'dynamicToolCall':
        case 'collabAgentToolCall': {
          const cards = startCards(cwd, item);
          for (const e of cards) {
            chapters.tool();
            put(e);
          }
          for (const [cid, error] of endStates(item)) put({ type: 'tool-result', id: cid, error });
          if (item.type === 'fileChange' && item.status === 'completed') {
            for (const e of cards) if (e.detail?.kind === 'diff') chapters.edited(e.detail.path, e.detail.add, e.detail.rm);
          }
          break;
        }
      }
    }
    if (turn.status === 'failed' && turn.error) put({ type: 'error', message: `Codex: ${oneLine(turn.error.message, 400)}` });
  }
  return out;
}

async function page(threadId: string, cursor: string | null) {
  return codex.request('thread/turns/list', { threadId, cursor, limit: TURNS_PAGE, sortDirection: 'desc', itemsView: 'full' });
}

// A saved thread's newest turns as events, enough to fill the in-memory log; `earlier` loads the rest when a page or Find needs it.
export async function codexHistory(threadId: string, cwd: string) {
  const newest: HistoryTurn[] = [];
  let cursor: string | null = null;
  let items = 0;
  do {
    const p = await page(threadId, cursor);
    newest.push(...p.data);
    items += p.data.reduce((a, t) => a + t.items.length, 0);
    cursor = p.nextCursor;
  } while (cursor && items < LOG_KEEP);
  const chapters = new Chapters();
  const tools = new ToolLog(cwd);
  const events = eventsOf(newest.reverse(), cwd, chapters, tools);
  const last = newest[newest.length - 1];
  chapters.end(last?.completedAt ? last.completedAt * 1000 : null);
  const from = cursor;
  const earlier = from
    ? async () => {
        const older: HistoryTurn[] = [];
        let c: string | null = from;
        for (let n = 0; c && n < PAGES_MAX; n++) {
          const p = await page(threadId, c);
          older.push(...p.data);
          c = p.nextCursor;
        }
        return eventsOf(older.reverse(), cwd, new Chapters(), new ToolLog(cwd));
      }
    : null;
  return { events, chapters, tools, earlier };
}
