import { create } from 'zustand';
import type { ChangeIndexFile, FileDiff } from '../../server/protocol.ts';

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

// Old-side lines loaded into a diff's collapsed gaps, by diff key: [first line, lines] ranges sorted by line.
export type Gaps = [number, string[]][];
export const useGaps = create<{ byKey: Record<string, Gaps> }>(() => ({ byKey: {} }));

export function putGaps(sessionId: string, id: string, path: string, from: number, lines: string[]) {
  if (!lines.length) return;
  useGaps.setState((s) => {
    const key = diffKey(sessionId, id, path);
    const { [key]: had = [], ...rest } = s.byKey;
    const keys = Object.keys(rest);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DIFFS + 1))) delete rest[k];
    const list = [...had.filter(([f]) => f !== from), [from, lines] as [number, string[]]].sort((a, b) => a[0] - b[0]);
    return { byKey: { ...rest, [key]: list } };
  });
}

// Net lines per file over the session; req says which changes-index it answers.
export const useIndex = create<{ bySession: Record<string, { req: string; files: ChangeIndexFile[] }> }>(() => ({ bySession: {} }));

export function putIndex(sessionId: string, req: string, files: ChangeIndexFile[]) {
  useIndex.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: { req, files } } }));
}

// The diff viewer's latest revert or undo, until the next one or the viewer closes.
export type RevertState = { sessionId: string; req: string; label: string; undoing: boolean; state: 'pending' | 'done' | 'failed'; error: string | null; undo: string | null };
export const useRevert = create<{ last: RevertState | null }>(() => ({ last: null }));

export function startRevert(sessionId: string, req: string, label: string, undoing: boolean) {
  useRevert.setState({ last: { sessionId, req, label, undoing, state: 'pending', error: null, undo: null } });
}

export function putReverted(sessionId: string, req: string, error: string | null, undo: string | null) {
  useRevert.setState((s) => (s.last?.sessionId === sessionId && s.last.req === req ? { last: { ...s.last, state: error ? 'failed' : 'done', error, undo } } : s));
}

export function clearRevert() {
  if (useRevert.getState().last) useRevert.setState({ last: null });
}

function dropWhere(pre: string) {
  const s = useDiffs.getState().byKey;
  if (Object.keys(s).some((k) => k.startsWith(pre))) useDiffs.setState({ byKey: Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(pre))) });
  const g = useGaps.getState().byKey;
  if (Object.keys(g).some((k) => k.startsWith(pre))) useGaps.setState({ byKey: Object.fromEntries(Object.entries(g).filter(([k]) => !k.startsWith(pre))) });
}

// A card that grew makes its loaded diffs stale.
export function dropDiffs(sessionId: string, id: string) {
  dropWhere(`${sessionId}|${id}|`);
}

export function dropSessionDiffs(sessionId: string) {
  dropWhere(`${sessionId}|`);
  if (useIndex.getState().bySession[sessionId]) {
    useIndex.setState((s) => {
      const { [sessionId]: _, ...rest } = s.bySession;
      return { bySession: rest };
    });
  }
}
