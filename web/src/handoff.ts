import { AGENT_NOTE_PREFIX, HANDOFF_PREFIX, SUMMARY_PREFIX, type HandoffState } from '../../server/protocol.ts';

// Maps from an older server have no handoff field.
export const handoffLive = (h: HandoffState | null | undefined) => !!h && (h.phase === 'writing' || h.phase === 'compacting' || h.phase === 'handing');

export type HandoffNote = { kind: 'handoff' | 'summary'; path: string | null; title: string; body: string };

const TAIL = '\n\n---\nThis message was sent automatically.';

// First Markdown heading, else the first non-empty line, without markup.
function titleOf(body: string) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^#{1,6}\s/.test(l)) ?? lines[0] ?? '';
  return line.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim();
}

// The hand-over message or a compaction summary, as a card instead of a giant bubble.
// The agents panel's relay message: '[Message for agent "name" · id]\n<instruction>\n\n<text>'.
export function parseAgentNote(text: string) {
  if (!text.startsWith(AGENT_NOTE_PREFIX)) return null;
  const m = /^\[Message for agent "(.*)" · [^\]]+\]\n[^\n]*\n\n([\s\S]*)$/.exec(text);
  return m ? { name: m[1], text: m[2] } : null;
}

export function parseNote(text: string): HandoffNote | null {
  if (text.startsWith(HANDOFF_PREFIX)) {
    const nl = text.indexOf('\n');
    const path = text.slice(HANDOFF_PREFIX.length, nl < 0 ? undefined : nl).replace(/\.$/, '');
    const start = text.indexOf('\n\n');
    let body = start < 0 ? '' : text.slice(start + 2);
    const cut = body.lastIndexOf(TAIL);
    if (cut >= 0) body = body.slice(0, cut);
    return { kind: 'handoff', path, title: titleOf(body) || 'Handoff', body };
  }
  if (text.startsWith(SUMMARY_PREFIX)) return { kind: 'summary', path: null, title: 'Earlier turns were summarized', body: text };
  return null;
}
