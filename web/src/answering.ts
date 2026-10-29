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
  return mark(id);
}

// An ask from a session in a terminal, through its hook.
export function answerTerminal(id: string, allow: boolean, always = false) {
  if (isAnswering(id)) return false;
  if (!send({ type: 'terminal-answer', id, allow, ...(always ? { always: true as const } : {}) })) return false;
  return mark(id);
}

// Asks whose card is on screen; their heads-up hides so the same buttons never show twice.
export const useOnScreen = create<{ ids: Record<string, true> }>(() => ({ ids: {} }));
const ON_SCREEN_MIN = 0.6;
const watched = new Map<Element, string>();
let io: IntersectionObserver | null = null;

function setOnScreen(id: string, on: boolean) {
  useOnScreen.setState((s) => {
    if (!!s.ids[id] === on) return s;
    const { [id]: _, ...ids } = s.ids;
    return { ids: on ? { ...ids, [id]: true } : ids };
  });
}

export function watchAsk(el: Element, id: string) {
  io ??= new IntersectionObserver((es) => {
    for (const e of es) {
      const at = watched.get(e.target);
      if (at) setOnScreen(at, e.isIntersecting && e.intersectionRatio >= ON_SCREEN_MIN);
    }
  }, { threshold: [0, ON_SCREEN_MIN] });
  watched.set(el, id);
  io.observe(el);
  return () => {
    watched.delete(el);
    io?.unobserve(el);
    setOnScreen(id, false);
  };
}

function mark(id: string) {
  useAnswering.setState((s) => ({ ids: { ...s.ids, [id]: true } }));
  setTimeout(() => useAnswering.setState((s) => {
    const { [id]: _, ...ids } = s.ids;
    return { ids };
  }), ANSWERING_MS_MAX);
  return true;
}
