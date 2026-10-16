import { create } from 'zustand';
import type { FileDiff } from '../../server/protocol.ts';

// Full file diffs loaded for the diff viewer, by "sessionId|cardId|path"; null means the server no longer has it.
export const useDiffs = create<{ byKey: Record<string, FileDiff | null> }>(() => ({ byKey: {} }));

// Oldest loaded diffs drop first; the viewer asks again when one it shows is gone.
const MAX_DIFFS = 60;

export const diffKey = (sessionId: string, id: string, path: string) => `${sessionId}|${id}|${path}`;

export function putDiff(sessionId: string, id: string, path: string, diff: FileDiff | null) {
  useDiffs.setState((s) => {
    const key = diffKey(sessionId, id, path);
    const { [key]: _, ...rest } = s.byKey;
    const keys = Object.keys(rest);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DIFFS + 1))) delete rest[k];
    return { byKey: { ...rest, [key]: diff } };
  });
}

function dropWhere(pre: string) {
  const s = useDiffs.getState().byKey;
  if (!Object.keys(s).some((k) => k.startsWith(pre))) return;
  useDiffs.setState({ byKey: Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(pre))) });
}

// A card that grew makes its loaded diffs stale.
export function dropDiffs(sessionId: string, id: string) {
  dropWhere(`${sessionId}|${id}|`);
}

export function dropSessionDiffs(sessionId: string) {
  dropWhere(`${sessionId}|`);
}
