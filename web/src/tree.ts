// The file tree's data, kept apart from the main store; it holds one session's folder at a time.
import { create } from 'zustand';
import type { ServerMessage, TreeEntry, TreeFile } from '../../server/protocol.ts';

export type DirState = { entries: TreeEntry[]; more: number } | { error: string } | 'loading';
export type FileState = TreeFile | 'loading';
// Go to file: the query typed, and the answer for it once it lands (null while it is asked).
// stale: found still shows an earlier query's answer.
export type FindState = { query: string; found: { paths: string[]; more: boolean; git: boolean } | { error: string } | null; stale?: true };

type Tree = {
  sessionId: string | null;
  // Keyed by path relative to the session folder; '' is the root.
  dirs: Record<string, DirState>;
  open: Record<string, true>;
  selected: string | null;
  line: number | null;
  file: FileState | null;
  hidden: boolean;
  find: FindState | null;
};

export const useTree = create<Tree>(() => ({ sessionId: null, dirs: {}, open: {}, selected: null, line: null, file: null, hidden: false, find: null }));

export function bindTree(sessionId: string) {
  if (useTree.getState().sessionId !== sessionId) useTree.setState({ sessionId, dirs: {}, open: {}, selected: null, line: null, file: null, find: null });
}

export function applyTree(msg: Extract<ServerMessage, { type: 'tree' | 'tree-file' | 'tree-found' }>) {
  useTree.setState((s) => {
    if (msg.sessionId !== s.sessionId) return s;
    if (msg.type === 'tree') {
      const { type: _t, sessionId: _s, path, ...dir } = msg;
      return { dirs: { ...s.dirs, [path]: dir } };
    }
    if (msg.type === 'tree-found') {
      const { type: _t, sessionId: _s, query, ...found } = msg;
      // A superseded query's answer is dropped.
      return s.find?.query === query ? { find: { query, found } } : s;
    }
    const { type: _t, sessionId: _s, path, ...file } = msg;
    return path === s.selected ? { file } : s;
  });
}
