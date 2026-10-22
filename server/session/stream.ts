import type { SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ServerEvent } from '../protocol.ts';
import { STREAMED, VISUAL_TOOL, describeTool, parsePartial, type ToolLog } from '../tools.ts';
import { connect } from '../connect.ts';
import { localOutput } from '../commands.ts';
import { isPlaceholder } from '../text.ts';
import { tuning } from '../profile.ts';
import { guard } from './util.ts';

// skip tracks render_ui's html value: where it starts (prefix is the input before it) and, once closed, where the rest begins.
type HtmlSkip = { prefix: string; pos: number; esc: boolean; tail: number | null };
type Streaming = { id: string; name: string; json: string; timer: ReturnType<typeof setTimeout> | null; skip?: HtmlSkip };

const HTML_KEY = /"html"\s*:\s*"/;
const LOCAL_SEEN_MAX = 200;

// The input to parse so far. render_ui's html is not shown until done, so it is left out and each parse stays small.
function partialJson(st: Streaming): string {
  if (st.name !== VISUAL_TOOL) return st.json;
  if (!st.skip) {
    const m = HTML_KEY.exec(st.json);
    if (!m) return st.json;
    st.skip = { prefix: `${st.json.slice(0, m.index)}"html":""`, pos: m.index + m[0].length, esc: false, tail: null };
  }
  const s = st.skip;
  // Scans only the new chunk for the closing quote.
  for (; s.tail === null && s.pos < st.json.length; s.pos++) {
    const c = st.json[s.pos];
    if (s.esc) s.esc = false;
    else if (c === '\\') s.esc = true;
    else if (c === '"') s.tail = s.pos + 1;
  }
  return s.tail === null ? s.prefix : s.prefix + st.json.slice(s.tail);
}
export type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
export type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

export type StreamHost = {
  cwd: string;
  tools: ToolLog;
  // A phone turn holds the stream until its prompt is read.
  intercept: (m: SDKMessage) => boolean;
  track: (m: SDKMessage) => void;
  lifecycle: (uuid: string | undefined, state: string | undefined) => void;
  openTurn: () => void;
  // A streamed chunk of the main reply.
  replyDelta: (id: string, delta: string) => void;
  // A whole text block that never streamed; delta is what the chat shows.
  replyText: (id: string, text: string, delta: string, synthetic: boolean) => void;
  activity: (text: string) => void;
  push: (e: ServerEvent) => void;
  touch: () => void;
  // Every tool_use in an assistant message, subagents' included.
  toolSeen: (id: string, name: string, input: unknown) => void;
  mainToolCall: (id: string, name: string, input: unknown) => void;
  dropLogPartials: (id: string) => void;
  toolResult: (id: string, content: unknown, isError: boolean) => void;
  result: (m: ResultMessage) => void;
  rateLimit: (info: SDKRateLimitInfo) => void;
  system: (m: SystemMessage) => void;
};

// The Claude CLI's message stream: streamed text and tool input, assistant blocks and tool results; turn ends and system events go back to the core.
export class Stream {
  private host: StreamHost;
  // Message ids of this turn whose text came as deltas; cleared at turn end.
  private streamedIds = new Set<string>();
  private currentMsgId: string | null = null;
  private streaming = new Map<number, Streaming>();
  private lastPartial = new Map<string, string>();
  // A compaction re-sends kept local command output under the same uuid, often turns later; capped at LOCAL_SEEN_MAX.
  private localSeen = new Set<string>();

  constructor(host: StreamHost) {
    this.host = host;
  }

  handle(m: SDKMessage) {
    const h = this.host;
    if (h.intercept(m)) return;
    h.track(m);
    const life = m as unknown as { type: string; command_uuid?: string; state?: string };
    if (life.type === 'command_lifecycle') return h.lifecycle(life.command_uuid, life.state);
    switch (m.type) {
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev.type === 'message_start') {
          this.currentMsgId = ev.message.id;
          this.stop();
          h.openTurn();
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.currentMsgId) {
          this.streamedIds.add(this.currentMsgId);
          h.replyDelta(`${this.currentMsgId}:${ev.index}`, ev.delta.text);
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use' && STREAMED.has(ev.content_block.name)) {
          const b = ev.content_block;
          this.streaming.set(ev.index, { id: b.id, name: b.name, json: '', timer: null });
          this.partial(b.id, b.name, {});
          h.activity(describeTool(h.cwd, b.name, {}));
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
          const st = this.streaming.get(ev.index);
          if (!st) return;
          st.json += ev.delta.partial_json;
          st.timer ??= setTimeout(() => guard('partial input', () => {
            st.timer = null;
            if (this.streaming.get(ev.index) !== st) return;
            const input = parsePartial(partialJson(st));
            if (input && typeof input === 'object') this.partial(st.id, st.name, input);
          }), tuning().partialMs);
        } else if (ev.type === 'content_block_stop') {
          const st = this.streaming.get(ev.index);
          if (st?.timer) clearTimeout(st.timer);
          this.streaming.delete(ev.index);
        }
        return;
      }
      case 'assistant': {
        h.touch();
        for (const block of m.message.content) if (block.type === 'tool_use') h.toolSeen(block.id, block.name, block.input);
        if (m.parent_tool_use_id) return;
        if (m.message.model !== '<synthetic>') h.openTurn();
        // The CLI's own text says to run /login, which this app has no use for; a fresh check shows the sign-in gate instead.
        const signedOut = m.error === 'authentication_failed';
        if (signedOut) {
          void connect.recheck();
          h.push({ type: 'error', message: 'Claude is signed out or its sign-in expired. Sign in again from Settings › Account.' });
        } else if (m.error) h.push({ type: 'error', message: `Assistant error: ${m.error}` });
        const msg = m.message;
        for (const block of msg.content) {
          if (signedOut && block.type === 'text') continue;
          if (block.type === 'tool_use') {
            this.dropPartials(block.id);
            h.mainToolCall(block.id, block.name, block.input);
          } else if (block.type === 'text' && !this.streamedIds.has(msg.id)) {
            const synthetic = msg.model === '<synthetic>';
            if (synthetic && this.localSeen.has(m.uuid)) continue;
            // The CLI's filler for a turn that never answered; it arrives with the next prompt, after the quiet notice.
            if (synthetic && isPlaceholder(block.text)) continue;
            if (synthetic) {
              this.localSeen.add(m.uuid);
              if (this.localSeen.size > LOCAL_SEEN_MAX) this.localSeen.delete(this.localSeen.values().next().value!);
            }
            // Fallback for text that never arrived as deltas. <synthetic> marks a local command's output (/usage, /context), not a model reply.
            h.replyText(`${msg.id}:${m.uuid}`, block.text, synthetic ? localOutput(block.text) : block.text, synthetic);
          }
        }
        return;
      }
      case 'user': {
        if (m.parent_tool_use_id || !Array.isArray(m.message.content)) return;
        for (const b of m.message.content) {
          if (b.type !== 'tool_result') continue;
          h.toolResult(b.tool_use_id, b.content, !!b.is_error);
        }
        return;
      }
      case 'result':
        return h.result(m);
      case 'rate_limit_event':
        return h.rateLimit(m.rate_limit_info);
      case 'system':
        return h.system(m);
    }
  }

  // A streaming rich tool's input so far; replaced in the log by the final call.
  private partial(id: string, name: string, input: object) {
    const ev = this.host.tools.call(id, name, input, true);
    if (!ev) return;
    // render_ui streams its html, which is not shown until done; unchanged frames are not resent.
    const json = JSON.stringify(ev);
    if (this.lastPartial.get(id) === json) return;
    this.lastPartial.set(id, json);
    this.host.push(ev);
  }

  private dropPartials(id: string) {
    for (const [k, st] of this.streaming) {
      if (st.id !== id) continue;
      if (st.timer) clearTimeout(st.timer);
      this.streaming.delete(k);
    }
    this.host.dropLogPartials(id);
    this.lastPartial.delete(id);
  }

  stop() {
    for (const st of this.streaming.values()) if (st.timer) clearTimeout(st.timer);
    this.streaming.clear();
  }

  // Calls still streaming their input; they never get a result of their own.
  partialIds() {
    return this.lastPartial.keys();
  }

  // Turn end: a message's deltas and its assistant blocks never span two turns.
  turnEnded() {
    this.lastPartial.clear();
    this.streamedIds.clear();
  }
}
