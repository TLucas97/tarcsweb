import { create } from 'zustand';
import type { ServerMessage } from '../../server/protocol.ts';

// A failed command's output, loaded on request; lines null means the server no longer keeps it.
export type ToolOutput = { lines: string[] | null; more: boolean } | 'loading';

// Keyed by outKey; the oldest go past OUT_MAX.
const OUT_MAX = 20;
export const useToolOutput = create<Record<string, ToolOutput>>(() => ({}));
export const outKey = (sessionId: string, id: string) => `${sessionId}\n${id}`;

function put(key: string, v: ToolOutput) {
  useToolOutput.setState((s) => {
    const next = { ...s };
    delete next[key];
    next[key] = v;
    const keys = Object.keys(next);
    for (let i = 0; i < keys.length - OUT_MAX; i++) delete next[keys[i]];
    return next;
  }, true);
}

export const markOutputLoading = (key: string) => put(key, 'loading');

export function applyToolOutput(msg: Extract<ServerMessage, { type: 'tool-output' }>) {
  put(outKey(msg.sessionId, msg.id), { lines: msg.lines, more: msg.more });
}
