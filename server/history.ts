import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment, ServerEvent, TimedEvent } from './protocol.ts';
import { HANDOFF_PREFIX, SUMMARY_PREFIX } from './protocol.ts';
import { PLUMBING, ToolLog } from './tools.ts';
import { Chapters } from './chapters.ts';
import { displayPath, fileDelta } from './agents.ts';
import { imageUrl } from './files.ts';

const MAX_EVENTS = 400;
// Slash-command wrappers, hook output and interrupt markers the CLI stores as user turns.
export const NOISE = /^\s*(<(command-[a-z]+|local-command-[a-z]+|system-reminder|task-notification|bash-[a-z]+|user-prompt-submit-hook)>|Caveat:|\[Request interrupted)/;

export type Block = {
  type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; title?: string;
  source?: { type?: string; media_type?: string; data?: string };
};
export const FILE_TEXT = /^File (.+?):\n\n/;
// A typed /command is stored as tags; shown again as the user typed it.
const CMD_NAME = /<command-name>\/?([^<]+)<\/command-name>/;
const CMD_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
export function slashOf(text: string) {
  const name = CMD_NAME.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = CMD_ARGS.exec(text)?.[1]?.trim();
  return `/${name}${args ? ` ${args}` : ''}`;
}
// Images show from the cached file's signed URL; base64 never goes into the events.
export function attachmentsOf(content: Block[]): Attachment[] {
  const out: Attachment[] = [];
  for (const b of content) {
    if (b.type === 'image') {
      const d = b.source?.type === 'base64' ? b.source.data : undefined;
      const src = d ? imageUrl(b.source!.media_type, d) : null;
      out.push({ name: 'Image', kind: 'image', ...(src ? { src } : {}) });
    } else if (b.type === 'document') out.push({ name: b.title || 'PDF', kind: 'pdf' });
    else if (b.type === 'text' && FILE_TEXT.test(b.text ?? '')) out.push({ name: FILE_TEXT.exec(b.text!)![1], kind: 'text' });
  }
  return out;
}

function blocks(message: unknown): Block[] | string | null {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? (content as Block[]) : null;
}

// The transcript line's time; present at runtime though SessionMessage does not declare it.
function timeOf(m: SessionMessage) {
  const t = Date.parse((m as { timestamp?: string }).timestamp ?? '');
  return Number.isFinite(t) ? t : null;
}

// Turns a transcript into the same events a live session emits, plus its chapters and tool memory; subagent text is skipped.
export function historyOf(messages: SessionMessage[], cwd: string): { events: TimedEvent[]; chapters: Chapters; tools: ToolLog } {
  const out: TimedEvent[] = [];
  let at: number | null = null;
  const put = (e: ServerEvent) => out.push(at === null ? e : { ...e, at });
  const chapters = new Chapters();
  const tools = new ToolLog(cwd);
  const fileCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  let lastAt: number | null = null;
  for (const m of messages) {
    const content = blocks(m.message);
    at = timeOf(m);
    const prevAt = lastAt;
    lastAt = at ?? lastAt;
    if (!content) continue;
    if (typeof content !== 'string') {
      for (const b of content) {
        if (b.type === 'tool_use' && b.id && !PLUMBING.has(b.name ?? '')) {
          chapters.tool();
          if (b.input && typeof b.input === 'object') fileCalls.set(b.id, { name: b.name ?? '', input: b.input as Record<string, unknown> });
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          const res = m.parent_tool_use_id ? null : tools.result(b.tool_use_id, (b as { content?: unknown }).content, !!b.is_error);
          if (res) put(res);
          const call = fileCalls.get(b.tool_use_id);
          fileCalls.delete(b.tool_use_id);
          const d = call && !b.is_error ? fileDelta(call.name, call.input) : null;
          if (d?.mode === 'read') chapters.read(displayPath(cwd, d.path));
          else if (d) chapters.edited(displayPath(cwd, d.path), d.add, d.rm);
        }
      }
    }
    if (m.parent_tool_use_id) continue;
    if (m.type === 'user') {
      const raw = typeof content === 'string' ? content : content.filter((b) => b.type === 'text' && !FILE_TEXT.test(b.text ?? '')).map((b) => b.text ?? '').join('\n');
      const text = slashOf(raw) ?? raw;
      const files = typeof content === 'string' ? [] : attachmentsOf(content);
      // An interrupt right after a prompt means Claude never answered it.
      const last = out[out.length - 1];
      if (/^\s*\[Request interrupted/.test(text) && last?.type === 'user') out[out.length - 1] = { ...last, stopped: true };
      if ((text.trim() || files.length) && !NOISE.test(text)) {
        put({ type: 'user', id: m.uuid, text, ...(files.length ? { files } : {}) });
        if (chapters.size) chapters.end(prevAt);
        const label = text.startsWith(HANDOFF_PREFIX) ? 'Context handoff' : text.startsWith(SUMMARY_PREFIX) ? 'Compaction summary' : text;
        chapters.start(m.uuid, text.trim() ? label : files.map((f) => f.name).join(', '), at);
      }
    } else if (m.type === 'assistant' && typeof content !== 'string') {
      content.forEach((b, i) => {
        if (b.type === 'text' && b.text?.trim()) {
          put({ type: 'text', id: `${m.uuid}:${i}`, delta: b.text });
          chapters.text(b.text + '\n');
        }
        else if (b.type === 'tool_use' && b.id) {
          const ev = tools.call(b.id, b.name ?? 'tool', b.input);
          if (ev) put(ev);
        }
      });
    }
  }
  chapters.end(lastAt);
  return { events: out.slice(-MAX_EVENTS), chapters, tools };
}
