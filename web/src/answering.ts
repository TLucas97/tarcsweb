import { create } from 'zustand';
import type { AskReply } from '../../server/protocol.ts';
import { send } from './socket.ts';

// Permission ids with an answer on its way, shared by the card, its heads-up and the Enter/n keys.
export const useAnswering = create<{ ids: Record<string, true> }>(() => ({ ids: {} }));
// An answer the server never confirmed frees the ask again after this long.
const ANSWERING_MS_MAX = 5000;

export const isAnswering = (id: string) => !!useAnswering.getState().ids[id];

// Sends at most one answer per ask; false when one is already on its way or the socket is down.
export function answerAsk(sessionId: string, id: string, allow: boolean, reply?: AskReply) {
  if (isAnswering(id)) return false;
  if (!send({ type: 'permission-answer', sessionId, id, allow, ...(reply ? { reply } : {}) })) return false;
  useAnswering.setState((s) => ({ ids: { ...s.ids, [id]: true } }));
  setTimeout(() => useAnswering.setState((s) => {
    const { [id]: _, ...ids } = s.ids;
    return { ids };
  }), ANSWERING_MS_MAX);
  return true;
}
