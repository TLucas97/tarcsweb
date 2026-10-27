// One request to the server's file listing for mentions; null when the socket is down or no answer came.
import { onMentions, send } from '../socket.ts';
import type { ServerMessage } from '../../../server/protocol.ts';

export type MentionsReply = Extract<ServerMessage, { type: 'mentions' }>;
type Ask = { type: 'mention-find'; sessionId: string; query: string } | { type: 'mention-list'; sessionId: string; path: string };

const WAIT_MS = 10_000;
const waiting = new Map<string, (m: MentionsReply | null) => void>();
let n = 0;

onMentions((m) => {
  const fn = waiting.get(m.req);
  waiting.delete(m.req);
  fn?.(m);
});

export function askMentions(msg: Ask): Promise<MentionsReply | null> {
  const req = `mn${++n}`;
  return new Promise((ok) => {
    if (!send({ ...msg, req })) return ok(null);
    waiting.set(req, ok);
    setTimeout(() => waiting.delete(req) && ok(null), WAIT_MS);
  });
}
