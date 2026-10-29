import { Suspense, lazy, useEffect } from 'react';
import { create } from 'zustand';
import { currentSummary, useStore } from './store.ts';
import { send } from './socket.ts';
import { closeFocus, openPanel, useFocus } from './Focus.tsx';
import { bindTree, useTree } from './tree.ts';
import { tilde } from './bits.tsx';
import { isDark, onTheme } from './theme.ts';
import { ChunkGuard } from './Stale.tsx';

// The Files panel's entry: the trigger, openFile and FileIcon. The panel body (FilesPanel.tsx) loads on first use.
const loadPanel = () => import('./FilesPanel.tsx');
const FilesPanel = lazy(loadPanel);

const KEY = 'files';

const parentsOf = (rel: string) => rel.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'));
export const filesOpen = () => {
  const v = useFocus.getState().view;
  return v?.mode === 'panel' && v.key === KEY;
};

export function listDir(path: string) {
  const { sessionId, dirs } = useTree.getState();
  if (!sessionId) return;
  // Re-listed on every expand so new files show up; the old entries stay until the answer lands.
  const d = dirs[path];
  if (!d || (d !== 'loading' && 'error' in d)) useTree.setState((s) => ({ dirs: { ...s.dirs, [path]: 'loading' } }));
  send({ type: 'tree-list', sessionId, path });
}

export function selectFile(path: string, line: number | null = null) {
  const { sessionId } = useTree.getState();
  if (!sessionId) return;
  useTree.setState({ selected: path, line, file: 'loading' });
  send({ type: 'tree-read', sessionId, path });
}

// Unfolds the folders above rel and shows it in the viewer.
export function revealFile(rel: string, line: number | null = null) {
  const open = { ...useTree.getState().open };
  for (const dir of parentsOf(rel)) {
    if (!open[dir]) listDir(dir);
    open[dir] = true;
  }
  useTree.setState({ open });
  if (!useTree.getState().dirs['']) listDir('');
  selectFile(rel, line);
}

// Path relative to the session folder; null when it points elsewhere.
function relOf(cwd: string, path: string) {
  let p = path.trim().replace(/^file:\/\//, '');
  if (p.startsWith('/')) {
    if (p === cwd) return '';
    if (!p.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) return null;
    p = p.slice(cwd.length);
  }
  const parts = p.split('/').filter((s) => s && s !== '.');
  return parts.includes('..') ? null : parts.join('/');
}

function FilesBody() {
  return (
    <ChunkGuard fallback={<div className="ft-empty">The file browser could not load. Reload the page.</div>}>
      <Suspense fallback={<div className="ft-empty"><span className="spin"></span><span className="sr" role="status">Loading…</span></div>}>
        <FilesPanel />
      </Suspense>
    </ChunkGuard>
  );
}

function show(from: Element) {
  const s = useStore.getState();
  const summary = currentSummary(s);
  if (!summary) return;
  openPanel({ key: KEY, label: tilde(summary.cwd, s.home), body: <FilesBody />, foot: 'read only' }, from);
}

// Opens the tree on a file of the current session, unfolding its folders; meant for file:line links later.
export function openFile(path: string, line?: number, from?: Element) {
  const s = useStore.getState();
  const summary = currentSummary(s);
  if (!s.current || !summary) return false;
  const rel = relOf(summary.cwd, path);
  if (rel === null || !rel) return false;
  bindTree(s.current);
  prefetchIcons();
  revealFile(rel, line && line > 0 ? Math.floor(line) : null);
  if (!filesOpen()) {
    closeFocus(true);
    show(from ?? document.querySelector('.ft-open') ?? document.body);
  }
  return true;
}

// Icons come from a lazy chunk (the icon theme's lookup tables); each SVG loads the first time a row shows it.
type IconMod = typeof import('./fileIcons.ts');
const useIcons = create<{ mod: IconMod | null; urls: Record<string, string>; dark: boolean }>(() => ({ mod: null, urls: {}, dark: isDark() }));
onTheme(() => useIcons.setState({ dark: isDark() }));
let iconMod: Promise<unknown> | null = null;
const asked = new Set<string>();
const prefetchIcons = () => {
  iconMod ??= import('./fileIcons.ts').then((mod) => useIcons.setState({ mod }), () => {});
};

export function FileIcon({ name, dir, open }: { name: string; dir: boolean; open: boolean }) {
  const mod = useIcons((s) => s.mod);
  const dark = useIcons((s) => s.dark);
  const icon = mod ? mod.iconName(name, dir, open, dark) : null;
  const url = useIcons((s) => (icon ? s.urls[icon] : undefined));
  useEffect(() => {
    if (!mod) return prefetchIcons();
    if (!icon || asked.has(icon)) return;
    asked.add(icon);
    mod.iconUrl(icon).then((u) => u && useIcons.setState((s) => ({ urls: { ...s.urls, [icon]: u } })), () => {});
  }, [mod, icon]);
  return url ? <img className="ft-ic" src={url} alt="" draggable={false} /> : <span className="ft-ic" />;
}

export const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M1.8 3.2h3.6l1.3 1.4h5.5v6.6H1.8z" /></svg>
);

// The header menu's Files entry: warmed on hover, opened on click.
export function prefetchFiles() {
  prefetchIcons();
  void loadPanel().catch(() => {});
}
export function openFiles(from: Element) {
  const id = useStore.getState().current;
  if (!id) return;
  bindTree(id);
  listDir('');
  show(from);
}
