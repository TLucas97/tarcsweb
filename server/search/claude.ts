import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FILE_TEXT, NOISE, oneLine, slashOf } from '../text.ts';
import { SUMMARY_PREFIX } from '../protocol.ts';
import type { Sink, Source, SourceFile } from './db.ts';
import { eachLine } from './lines.ts';

const ROOT = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
// Top-level transcripts only; subagent logs live in subfolders.
const TRANSCRIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

// Most bytes are tool output and API dumps, so a line is judged by its first bytes and only kept ones are parsed.
const TITLE_TYPES = new Set(['custom-title', 'ai-title', 'last-prompt', 'tag']);
const TURN = /"role":"(user|assistant)"|"type":"queued_command"/;
const SKIP = /"isSidechain":true|"content":\[\{"(tool_use_id"|type":"(tool_use|tool_result|thinking|redacted_thinking)")/;
function wanted(head: string) {
  const type = /^\{"type":"([a-z-]+)"/.exec(head)?.[1];
  if (type && type !== 'user' && type !== 'assistant') return TITLE_TYPES.has(type);
  return TURN.test(head) && !SKIP.test(head);
}

// Harness text the CLI wraps into user turns (instructions, hook output, notifications).
const WRAPPED = /<(system-reminder|task-notification|user-prompt-submit-hook|local-command-std(?:out|err)|bash-std(?:out|err)|bash-input|command-message)>[\s\S]*?<\/\1>/g;

type Block = { type?: string; text?: unknown };
type Line = {
  type?: string; isMeta?: boolean; isSidechain?: boolean; isCompactSummary?: boolean; cwd?: unknown;
  customTitle?: unknown; aiTitle?: unknown; lastPrompt?: unknown; tag?: unknown;
  message?: { content?: unknown }; attachment?: { type?: string; isMeta?: boolean; prompt?: unknown };
};
const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function prompt(content: unknown, sink: Sink) {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content) ? (content as Block[]).filter((b) => b?.type === 'text' && typeof b.text === 'string' && !FILE_TEXT.test(b.text)).map((b) => b.text).join('\n') : '';
  const slash = slashOf(raw);
  if (!slash && NOISE.test(raw)) return;
  const text = slash ?? raw.replace(WRAPPED, '').trim();
  if (!text || text.startsWith(SUMMARY_PREFIX)) return;
  sink.text(text);
  if (!slash) sink.title('first', oneLine(text, 80));
}

function take(o: Line, sink: Sink) {
  switch (o.type) {
    case 'custom-title':
      return str(o.customTitle) && sink.title('custom', o.customTitle);
    case 'ai-title':
      return str(o.aiTitle) && sink.title('ai', o.aiTitle);
    case 'last-prompt':
      return str(o.lastPrompt) && sink.title('last', oneLine(o.lastPrompt, 80));
    case 'tag':
      return sink.tag(typeof o.tag === 'string' ? o.tag : '');
  }
  if (o.isSidechain || o.isMeta || o.isCompactSummary) return;
  if (str(o.cwd)) sink.cwd(o.cwd);
  if (o.type === 'attachment') {
    const a = o.attachment;
    if (a?.type === 'queued_command' && !a.isMeta) prompt(a.prompt, sink);
  } else if (o.type === 'user') prompt(o.message?.content, sink);
  else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const b of o.message.content as Block[]) if (b?.type === 'text' && str(b.text)) sink.text(b.text);
  }
}

export const claude: Source = {
  name: 'claude',

  async list() {
    let dirs;
    try {
      dirs = await readdir(ROOT, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: SourceFile[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = join(ROOT, d.name);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!TRANSCRIPT.test(name)) continue;
        const path = join(dir, name);
        const st = await stat(path).catch(() => null);
        if (st?.isFile()) out.push({ path, sid: name.slice(0, -6), mtime: st.mtimeMs, size: st.size });
      }
    }
    return out;
  },

  read(file, offset, sink) {
    return eachLine(file.path, offset, file.size, wanted, (line) => {
      let o: Line;
      try {
        o = JSON.parse(line.toString('utf8')) as Line;
      } catch {
        return;
      }
      take(o, sink);
    });
  },
};
