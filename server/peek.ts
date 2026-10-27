import type { SeqEvent } from './protocol.ts';

// Session widgets: a client may peek at a few sessions besides the one on screen, with a light event stream.
export const PEEK_MAX = 3;
// The tail a new peek starts from: enough for the last few exchanges, never the whole log.
const TAIL_EVENTS = 240;
const TAIL_PROMPTS = 12;

// What a widget draws: messages, tool lines and asks. Heavy payloads are emptied, keeping each event's shape.
export function liteEvent(e: SeqEvent): SeqEvent | null {
  switch (e.type) {
    case 'tool': {
      const d = e.detail;
      if (!d) return e;
      if (d.kind === 'diff') return { ...e, detail: { ...d, lines: [] } };
      if (d.kind === 'visual' || d.kind === 'prototype') return { ...e, detail: { ...d, html: '' } };
      if (d.kind === 'table') return { ...e, detail: { ...d, table: { ...d.table, rows: [] } } };
      return e;
    }
    case 'tool-result':
      return { type: 'tool-result', id: e.id, error: e.error, seq: e.seq, sessionId: e.sessionId, ...(e.choice !== undefined ? { choice: e.choice } : {}) };
    case 'permission':
      return e.detail ? { ...e, detail: { ...e.detail, lines: [] } } : e;
    case 'user':
      return e.files?.length ? { ...e, files: e.files.map((f) => ({ name: f.name, kind: f.kind })) } : e;
    case 'delivered':
    case 'unqueued':
    case 'text':
    case 'permission-resolved':
    case 'turn-end':
    case 'status':
    case 'error':
      return e;
    default:
      return null;
  }
}

// The newest events up to a few prompts back, oldest first.
export function peekTail(log: SeqEvent[]): SeqEvent[] {
  const out: SeqEvent[] = [];
  let prompts = 0;
  for (let i = log.length - 1; i >= 0 && out.length < TAIL_EVENTS; i--) {
    const e = liteEvent(log[i]);
    if (!e) continue;
    out.push(e);
    if (e.type === 'user' && ++prompts >= TAIL_PROMPTS) break;
  }
  return out.reverse();
}
