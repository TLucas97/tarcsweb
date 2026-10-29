import { open } from 'node:fs/promises';
import type { Attachment, RemoteState } from './protocol.ts';
import { FILE_TEXT, NOISE, attachmentsOf, slashOf, type Block } from './history.ts';
import { transcriptPath } from './watch.ts';

// On the SDK's Query class but missing from sdk.d.ts. session_url is the session's page on claude.ai/code.
type RemoteReply = { session_url?: unknown } | null | undefined;
export type RemoteControl = { enableRemoteControl?: (enabled: boolean, name?: string) => Promise<RemoteReply> };

export const remoteUrl = (r: RemoteReply) => (typeof r?.session_url === 'string' && /^https:\/\//.test(r.session_url) ? r.session_url : null);

// The CLI's bridge_state as the clients see it; failed is only final when the CLI says so.
export function bridgeState(state: unknown, detail: unknown, kind: unknown, cur: RemoteState): RemoteState {
  if (state === 'connected' || state === 'ready') return { state: 'on', url: cur.url };
  const why = typeof detail === 'string' && detail ? detail : 'The connection to claude.ai failed';
  if (state === 'policy_disabled' || (state === 'failed' && kind === 'terminal')) return { state: 'error', url: cur.url, error: why };
  return { state: 'connecting', url: cur.url };
}

// Rides on a phone turn's prompt: the Claude app shows replies as plain Markdown and cannot answer the app's own pickers.
export const PHONE_NOTE =
  'This message was sent from the Claude app or claude.ai through Remote Control, and the reader sees this reply there as plain Markdown. For this reply, ignore the web UI instructions: no ```ui blocks, no {{short|long}} stretches, no ask_round, ask_upload, ask_prototype or ask_checklist (ask in plain text instead), and no show_image or show_url (they show only in the web UI).';

// How much of the transcript's end is searched; a line with an image can be large.
const TAIL = 4 << 20;
// The CLI may write the line a moment after the turn starts.
const RETRY_MS = [0, 150, 400, 900, 1500];

export type PhoneMessage = { text: string; files: Attachment[] };

function messageOf(content: unknown): PhoneMessage | null {
  const blocks = Array.isArray(content) ? (content as Block[]) : null;
  const raw = typeof content === 'string' ? content : (blocks ?? []).filter((b) => b.type === 'text' && !FILE_TEXT.test(b.text ?? '')).map((b) => b.text ?? '').join('\n');
  const text = slashOf(raw) ?? raw;
  const files = blocks ? attachmentsOf(blocks) : [];
  return (text.trim() || files.length) && !NOISE.test(text) ? { text, files } : null;
}

// undefined while the line is not on disk yet; null when that uuid is not a message from Remote Control.
async function readOnce(path: string, uuid: string): Promise<PhoneMessage | null | undefined> {
  const fh = await open(path, 'r');
  let text: string;
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    text = buf.toString('utf8');
  } finally {
    await fh.close();
  }
  const key = `"uuid":"${uuid}"`;
  let at = text.lastIndexOf(key);
  while (at >= 0) {
    const start = text.lastIndexOf('\n', at) + 1;
    const end = text.indexOf('\n', at);
    try {
      const line = JSON.parse(text.slice(start, end < 0 ? undefined : end));
      if (line?.type === 'user' && line.uuid === uuid) return line.origin?.kind === 'human' ? messageOf(line.message?.content) : null;
    } catch {}
    at = at > 0 ? text.lastIndexOf(key, at - 1) : -1;
  }
  return undefined;
}

// The text of a message sent through Remote Control: the stream never carries it, the transcript does.
export async function phoneMessage(cwd: string, transcriptId: string, uuid: string): Promise<PhoneMessage | null> {
  let path: string | null = null;
  for (const ms of RETRY_MS) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    path ??= await transcriptPath(cwd, transcriptId);
    if (!path) continue;
    try {
      const found = await readOnce(path, uuid);
      if (found !== undefined) return found;
    } catch {}
  }
  return null;
}
