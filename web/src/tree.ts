// The file tree's data, kept apart from the main store; it holds one session's folder at a time.
import { create } from 'zustand';
import type { ServerMessage, TreeEntry, TreeFile } from '../../server/protocol.ts';

export type DirState = { entries: TreeEntry[]; more: number } | { error: string } | 'loading';
export type FileState = TreeFile | 'loading';

type Tree = {
  sessionId: string | null;
  // Keyed by path relative to the session folder; '' is the root.
  dirs: Record<string, DirState>;
  open: Record<string, true>;
  selected: string | null;
  line: number | null;
  file: FileState | null;
  hidden: boolean;
};

export const useTree = create<Tree>(() => ({ sessionId: null, dirs: {}, open: {}, selected: null, line: null, file: null, hidden: false }));

export function bindTree(sessionId: string) {
  if (useTree.getState().sessionId !== sessionId) useTree.setState({ sessionId, dirs: {}, open: {}, selected: null, line: null, file: null });
}

export function applyTree(msg: Extract<ServerMessage, { type: 'tree' | 'tree-file' }>) {
  useTree.setState((s) => {
    if (msg.sessionId !== s.sessionId) return s;
    if (msg.type === 'tree') {
      const { type: _t, sessionId: _s, path, ...dir } = msg;
      return { dirs: { ...s.dirs, [path]: dir } };
    }
    const { type: _t, sessionId: _s, path, ...file } = msg;
    return path === s.selected ? { file } : s;
  });
}
