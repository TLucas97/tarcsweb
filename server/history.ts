import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment, ServerEvent, TimedEvent, Wake } from './protocol.ts';
import { noteLabel } from './protocol.ts';
import { BUILDERS, IMAGE_NOTE, PLUMBING, ToolLog, checkIdOf, resultText } from './tools.ts';
import { Chapters } from './chapters.ts';
import { displayPath, fileDelta } from './agents.ts';
import { imageUrl } from './files.ts';
import { FILE_TEXT, NOISE, NOTE_START, isPlaceholder, slashOf, wakeOfNote } from './text.ts';
import { hasRef, linkedPrompt, type Piece } from './links.ts';
import { readOrigin } from './sessionOrigin.ts';

// Names one update header keeps when several notifications start the same turn.
export const WAKE_MAX = 5;

// They live in text.ts so the search worker can use them without this module's imports.
export { FILE_TEXT, NOISE, slashOf };

export type Block = {
  type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; title?: string;
  source?: { type?: string; media_type?: string; data?: string };
};
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

// A prompt sent with links reads back with its chips and highlighted spans.
function linkedOf(content: Block[]) {
  if (!content.some((b) => b.type === 'text' && hasRef(b.text ?? ''))) return null;
  return linkedPrompt(content.flatMap((b): Piece[] => {
    const f = attachmentsOf([b])[0];
    return f ? [{ file: f }] : b.type === 'text' ? [{ text: b.text ?? '' }] : [];
  }));
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
// Every event is returned; the session keeps the newest in memory and moves the rest to disk.
// subChecks: render_ui and ask_prototype checks a subagent ran (subagentChecks), fed in first so the main's shows draw them.
export function historyOf(messages: SessionMessage[], cwd: string, subChecks: SubCheck[] = []): { events: TimedEvent[]; chapters: Chapters; tools: ToolLog } {
  const out: TimedEvent[] = [];
  let at: number | null = null;
  const put = (e: ServerEvent) => out.push(at === null ? e : { ...e, at });
  const chapters = new Chapters();
  const tools = new ToolLog(cwd);
  for (const c of subChecks) {
    tools.subCall(c.id, c.name, c.input);
    tools.subResult(c.id, c.content);
  }
  const fileCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  let lastAt: number | null = null;
  // Notifications that started a turn; their header goes out before the turn's first visible row.
  let woke: { id: string; at: number | null; from: Wake[] } | null = null;
  const wake = () => {
    if (!woke) return;
    const e: ServerEvent = { type: 'wake', id: woke.id, from: woke.from };
    out.push(woke.at === null ? e : { ...e, at: woke.at });
    woke = null;
  };
  // A turn an agent's report opened that has not said anything real yet; it gets the quiet notice when it ends.
  let quiet: string | null = null;
  const hush = (t: number | null) => {
    if (!quiet) return;
    wake();
    const e: ServerEvent = { type: 'quiet', id: quiet };
    out.push(t === null ? e : { ...e, at: t });
    quiet = null;
  };
  let afterResults = false;
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
          if (m.parent_tool_use_id) tools.subCall(b.id, b.name ?? '', b.input);
          if (b.input && typeof b.input === 'object') fileCalls.set(b.id, { name: b.name ?? '', input: b.input as Record<string, unknown> });
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          if (m.parent_tool_use_id) tools.subResult(b.tool_use_id, (b as { content?: unknown }).content);
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
    const results = typeof content !== 'string' && content.some((b) => b.type === 'tool_result');
    // earlierMessages marks the mid-turn image notes it keeps.
    const midTurn = afterResults || results || (m as { midTurn?: boolean }).midTurn === true;
    afterResults = m.type === 'user' && results;
    if (m.type === 'user') {
      const linked = typeof content === 'string' ? null : linkedOf(content);
      const raw = linked ? linked.text : typeof content === 'string' ? content : content.filter((b) => b.type === 'text' && !FILE_TEXT.test(b.text ?? '')).map((b) => b.text ?? '').join('\n');
      const decoded = readOrigin(slashOf(raw) ?? raw);
      const text = decoded.text;
      const files = linked ? linked.files : typeof content === 'string' ? [] : attachmentsOf(content);
      // An interrupt right after a prompt means Claude never answered it.
      const last = out[out.length - 1];
      if (/^\s*\[Request interrupted/.test(text) && last?.type === 'user') out[out.length - 1] = { ...last, stopped: true };
      // A generate_image job's notification is its call's late result, wherever it was read; it fills the card.
      const late = NOTE_START.test(text) ? tools.imageNote(text) : null;
      if (late) put(late);
      // A notification after a reply started a turn; one read between tool results, or right after a prompt, joins that turn.
      if (NOTE_START.test(text) && !midTurn && last?.type !== 'user') {
        const w = wakeOfNote(text);
        // A silent turn that showed rows ends here; one that showed none merges with this one under a single header.
        if (!woke) hush(prevAt);
        woke ??= { id: `wake:${m.uuid}`, at, from: [] };
        if (w && woke.from.length < WAKE_MAX) woke.from.push(w);
        if (w?.via === 'agent') quiet ??= `quiet:${m.uuid}`;
      }
      if ((text.trim() || files.length) && !NOISE.test(text)) {
        hush(prevAt);
        woke = null;
        put({ type: 'user', id: m.uuid, ...decoded, ...(files.length ? { files } : {}), ...(linked?.pastes.length ? { pastes: linked.pastes } : {}), ...(linked?.links.length ? { links: linked.links } : {}) });
        if (chapters.size) chapters.end(prevAt);
        const label = noteLabel(text) ?? text;
        chapters.start(m.uuid, text.trim() ? label : files.map((f) => f.name).join(', '), at);
      }
    } else if (m.type === 'assistant' && typeof content !== 'string') {
      const synthetic = (m.message as { model?: string } | null)?.model === '<synthetic>';
      content.forEach((b, i) => {
        if (b.type === 'text' && b.text?.trim()) {
          // The CLI's filler for an unanswered turn, or Main's own placeholder in a quiet turn: the notice stands for it.
          if ((quiet || synthetic) && isPlaceholder(b.text)) return;
          quiet = null;
          wake();
          put({ type: 'text', id: `${m.uuid}:${i}`, delta: b.text });
          chapters.text(b.text + '\n');
        }
        else if (b.type === 'tool_use' && b.id) {
          const ev = tools.call(b.id, b.name ?? 'tool', b.input);
          if (ev) {
            wake();
            put(ev);
          }
        }
      });
    }
  }
  hush(lastAt);
  chapters.end(lastAt);
  return { events: out, chapters, tools };
}

type Raw = {
  type?: string; uuid?: string; parentUuid?: string | null; logicalParentUuid?: string | null; isSidechain?: boolean; isMeta?: boolean; teamName?: string;
  timestamp?: string; sessionId?: string; message?: unknown; attachment?: { type?: string; prompt?: unknown; isMeta?: boolean; source_uuid?: string };
};
const CHUNK = 1 << 20;

// Each line of a transcript with the byte offset it starts at; reads in chunks, without sync fs.
async function eachLine(path: string, fn: (line: string, at: number) => void) {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.allocUnsafe(CHUNK);
    let rest: Buffer[] = [];
    let restLen = 0;
    let pos = 0;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      let start = 0;
      for (let nl = buf.indexOf(10, 0); nl >= 0 && nl < bytesRead; nl = buf.indexOf(10, start)) {
        const part = buf.subarray(start, nl);
        fn((restLen ? Buffer.concat([...rest, part]) : part).toString('utf8'), pos - restLen + (restLen ? 0 : start));
        rest = [];
        restLen = 0;
        start = nl + 1;
      }
      if (start < bytesRead) {
        rest.push(Buffer.from(buf.subarray(start, bytesRead)));
        restLen += bytesRead - start;
      }
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}

export type SubCheck = { id: string; name: string; input: unknown; content: unknown };
// Unanswered check calls held per subagent file while it is read.
const SUB_CALLS_MAX = 50;

// The subagent checks behind the main's from_check shows. Subagent transcripts live apart, so they are read only when
// a show names a check_id the main transcript never returned; path resolves the main transcript lazily.
export async function subagentChecks(messages: SessionMessage[], path: () => Promise<string | null>): Promise<SubCheck[]> {
  const shown = new Set<string>();
  const have = new Set<string>();
  for (const m of messages) {
    const content = blocks(m.message);
    if (!content || typeof content === 'string') continue;
    for (const b of content) {
      const from = b.type === 'tool_use' && BUILDERS.has(b.name ?? '') ? (b.input as { from_check?: unknown } | null)?.from_check : undefined;
      if (typeof from === 'string') shown.add(from);
      const id = b.type === 'tool_result' ? checkIdOf(resultText((b as { content?: unknown }).content)) : undefined;
      if (id) have.add(id);
    }
  }
  const want = new Set([...shown].filter((c) => !have.has(c)));
  if (!want.size) return [];
  const main = await path();
  if (!main) return [];
  const dir = join(main.replace(/\.jsonl$/, ''), 'subagents');
  const files = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'));
  const out: SubCheck[] = [];
  for (const f of files) {
    if (!want.size) break;
    const calls = new Map<string, { name: string; input: unknown }>();
    await eachLine(join(dir, f), (line) => {
      // Check calls carry "check":true and their results "check_id: "; every other line is skipped unparsed.
      if (!want.size || !line.includes('check')) return;
      let content: Block[] | string | null;
      try {
        content = blocks((JSON.parse(line) as Raw).message);
      } catch {
        return;
      }
      if (!content || typeof content === 'string') return;
      for (const b of content) {
        if (b.type === 'tool_use' && b.id && BUILDERS.has(b.name ?? '') && (b.input as { check?: unknown } | null)?.check === true) {
          calls.set(b.id, { name: b.name!, input: b.input });
          if (calls.size > SUB_CALLS_MAX) calls.delete(calls.keys().next().value!);
        } else if (b.type === 'tool_result' && b.tool_use_id && calls.has(b.tool_use_id)) {
          const call = calls.get(b.tool_use_id)!;
          calls.delete(b.tool_use_id);
          const resultContent = (b as { content?: unknown }).content;
          const id = checkIdOf(resultText(resultContent));
          if (id && want.delete(id)) out.push({ id: b.tool_use_id, ...call, content: resultContent });
        }
      }
    }).catch(() => {});
  }
  return out;
}

// The conversation before `firstUuid`: getSessionMessages stops at the last compaction, so this walks the
// chain back across each compact boundary. Two passes, so only the chain's own messages stay parsed.
export async function earlierMessages(path: string, firstUuid: string): Promise<SessionMessage[]> {
  const links = new Map<string, { parent: string | null; logical: string | null; at: number }>();
  await eachLine(path, (line, at) => {
    if (!line.includes('"uuid"')) return;
    try {
      const o = JSON.parse(line) as Raw;
      if (o.uuid && !o.isSidechain) links.set(o.uuid, { parent: o.parentUuid ?? null, logical: o.logicalParentUuid ?? null, at });
    } catch {}
  });
  const chain: number[] = [];
  const seen = new Set<string>();
  let cur = links.get(firstUuid)?.parent ?? null;
  for (let node = cur ? links.get(cur) : undefined; node && cur && !seen.has(cur); node = cur ? links.get(cur) : undefined) {
    seen.add(cur);
    chain.push(node.at);
    cur = node.parent ?? node.logical;
  }
  if (!chain.length) return [];
  const want = new Set(chain);
  const out: SessionMessage[] = [];
  await eachLine(path, (line, at) => {
    if (!want.has(at)) return;
    let o: Raw;
    try {
      o = JSON.parse(line) as Raw;
    } catch {
      return;
    }
    const base = { session_id: o.sessionId ?? '', parent_tool_use_id: null, parent_agent_id: null, timestamp: o.timestamp };
    // A prompt typed while Claude worked is stored as a queued_command attachment.
    const a = o.attachment;
    // A notification read mid-turn is an attachment too; it did not start a turn, so it would read as a false update.
    // An image job's note stays, marked midTurn so it only fills its card's pictures.
    const midNote = typeof a?.prompt === 'string' && NOTE_START.test(a.prompt);
    const midImage = midNote && IMAGE_NOTE.test(a.prompt as string);
    if (o.type === 'attachment' && a?.type === 'queued_command' && !a.isMeta && (!midNote || midImage) && (typeof a.prompt === 'string' || Array.isArray(a.prompt))) {
      out.push({ ...base, type: 'user', uuid: a.source_uuid || o.uuid!, message: { role: 'user', content: a.prompt }, ...(midImage ? { midTurn: true } : {}) } as SessionMessage);
    } else if ((o.type === 'user' || o.type === 'assistant') && !o.isMeta && !o.teamName) {
      out.push({ ...base, type: o.type, uuid: o.uuid!, message: o.message } as SessionMessage);
    }
  });
  return out;
}
