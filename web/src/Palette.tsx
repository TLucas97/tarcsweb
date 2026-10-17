import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { setPalette, useStore, type PaletteMode } from './store.ts';
import { openSession, send, showStart } from './socket.ts';
import { closeSession, deleteSession, listDirs, renameSession, setArchived } from './actions.ts';
import {
  ArchiveIcon, ChevLeft, ChevRight, CodexTag, Glyph, HomeIcon, PencilIcon, RenameInput, TrashIcon, UnarchiveIcon, XIcon, ago, baseName, pref, reduceMotion, tilde, useArm,
} from './bits.tsx';
import { chainTo, levelLabel, parentOf, resolvePath } from './paths.ts';
import { activityOf } from './led.tsx';
import type { DockState, PastSession, SessionSummary } from '../../server/protocol.ts';
import { WidgetButton } from './widgets/WidgetButton.tsx';

// page: a folder's own page, with a new-session row and every session started there.
type Action = { go: string } | { resume: string } | { folder: true } | { path: string } | { page: string } | { start: true } | { ai: true };
// codex: the row gets the provider marker.
type Sess = { id: string; name: string; open: boolean; archived: boolean; codex: boolean };
type Row = {
  key: string; act: Action; section?: string; icon: ReactNode; name: ReactNode; meta?: ReactNode; side?: ReactNode; warn?: boolean;
  // Session rows get the action buttons; folder rows with subfolders get the arrow; sub rows sit under a folder row.
  sess?: Sess; enter?: string; sub?: boolean; newHere?: string;
  // A content search hit: the matching text, shown on its own line under the name.
  snip?: string;
  // Folder header in the grouped list; its icon collapses the sessions under it.
  group?: { cwd: string; open: boolean };
};

const MAX_PAST = 60;
// Sessions shown under each folder in the grouped list; the folder's page has the rest.
const GROUP_MAX = 3;
const HERE_MAX = 5;
const FOUND_MAX = 5;
// Same folded form as the server's folder search, so "area" finds "Área".
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const RANK: Record<DockState, number> = { waiting: 0, working: 2, done: 3, idle: 3 };
const SLIDE = { duration: 240, easing: 'cubic-bezier(.4,0,.2,1)' };

const FolderIcon = () => (
  <svg className="fold-ic" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" /></svg>
);
const HereIcon = () => (
  <svg className="fold-ic" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2zM6.5 7.2 9 9l-2.5 1.8" /></svg>
);
const HistIcon = () => (
  <svg className="hist" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="6" cy="6" r="4.6" /><path d="M6 3.6V6l1.6 1.1" /></svg>
);
const PlusIcon = () => <svg className="hist" viewBox="0 0 12 12"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
const SparkIcon = () => (
  <svg className="hist" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M6 1.2C6.5 4.6 7.4 5.5 10.8 6 7.4 6.5 6.5 7.4 6 10.8 5.5 7.4 4.6 6.5 1.2 6 4.6 5.5 5.5 4.6 6 1.2z" /></svg>
);
const Ent = () => <kbd className="ent">↵</kbd>;
// The server wraps each match in \u0002 and \u0003.
const Snippet = ({ text }: { text: string }) => text.split('\u0002').map((part, i) => {
  const end = part.indexOf('\u0003');
  if (!i || end < 0) return <Fragment key={i}>{part.replace('\u0003', '')}</Fragment>;
  return <Fragment key={i}><mark>{part.slice(0, end)}</mark>{part.slice(end + 1)}</Fragment>;
});
const count = (n: number) => `${n} session${n === 1 ? '' : 's'}`;
const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};

// While the palette is closed its lists keep their last value, so session switches and roster ticks don't re-render it.
function useWhileOpen<T>(pick: (s: ReturnType<typeof useStore.getState>) => T): T {
  const last = useRef<{ v: T } | null>(null);
  return useStore((s) => (s.palette || !last.current ? (last.current = { v: pick(s) }).v : last.current.v));
}

function useRows(
  mode: PaletteMode, query: string, archived: boolean, level: string | undefined, byFolder: boolean, page: string | null, collapsed: string[],
): { rows: Row[]; error?: string; empty?: string; hint?: string } {
  const roster = useWhileOpen((s) => s.roster);
  const current = useWhileOpen((s) => s.current);
  const curPattern = useWhileOpen((s) => activityOf(s.current ? s.maps[s.current]?.now : undefined));
  const past = useWhileOpen((s) => s.past);
  const folders = useWhileOpen((s) => s.folders);
  const home = useWhileOpen((s) => s.home);
  const listing = useWhileOpen((s) => (level ? s.dirs[level] : undefined));
  const found = useWhileOpen((s) => s.found);
  const searched = useWhileOpen((s) => s.searched);
  const q = fold(query.trim());
  const has = (x: string) => !q || fold(x).includes(q);
  const rows: Row[] = [];
  // The past list can lag behind the roster for a moment, and a session must not show twice.
  const openIds = new Set(roster.map((r) => r.id));
  const shownPast = past.filter((x) => !openIds.has(x.id));
  const live = shownPast.filter((x) => !x.archived);
  const rank = (id: string, st: DockState) => (id === current ? 1 : RANK[st]);
  const sessText = (x: { name: string; branch: string | null }) => `${x.name} ${x.branch ?? ''}`;
  const openRow = (x: SessionSummary, sub = false): Row => {
    const cur = x.id === current;
    return {
      key: `o:${x.id}`, act: { go: x.id }, sess: { id: x.id, name: x.name, open: true, archived: false, codex: x.provider === 'codex' }, sub,
      icon: <Glyph state={x.state} pattern={cur ? curPattern : undefined} background={x.background} />, name: x.name, meta: x.branch, warn: x.state === 'waiting',
      side: cur ? <span className="chip2">current</span> : x.state === 'working' ? '' : x.state === 'waiting' ? 'needs approval' : ago(x.lastActive),
    };
  };
  const pastRow = (x: PastSession, section?: string, sub = false, withPath = true): Row => ({
    key: `p:${x.id}`, act: { resume: x.id }, section, sess: { id: x.id, name: x.name, open: false, archived: x.archived, codex: x.provider === 'codex' }, sub,
    icon: <HistIcon />, name: x.name, meta: withPath ? tilde(x.cwd, home) : x.branch, side: ago(x.lastModified),
  });
  const inFolder = (cwd: string) => roster.filter((r) => r.cwd === cwd).length + live.filter((p) => p.cwd === cwd).length;
  // A folder that already has sessions opens its page; an empty one starts a session right away.
  const folderAct = (path: string): Action => (inFolder(path) ? { page: path } : { path });
  const folderSide = (path: string, branch: string | null | undefined) => {
    const n = inFolder(path);
    if (!n && !branch) return undefined;
    return <>{branch && <span className="mono">{branch}</span>}{n > 0 && <span>{count(n)}</span>}</>;
  };
  // Conversations whose text matches go after the title matches, skipping sessions already listed.
  // Returns a quiet hint while the first index build has found nothing yet.
  const addHits = (): string | undefined => {
    if (q.length < 2 || !searched || searched.query !== query.trim() || searched.cwd !== page) return;
    const listed = new Set(rows.flatMap((r) => (r.sess ? [r.sess.id] : [])));
    const hits = searched.hits.filter((h) => h.archived === archived && !listed.has(h.id));
    hits.forEach((h, i) => {
      const open = openIds.has(h.id);
      rows.push({
        key: `c:${h.id}`, act: open ? { go: h.id } : { resume: h.id }, section: i === 0 ? `Found in conversations${searched.indexing ? ' · still indexing' : ''}` : undefined,
        sess: { id: h.id, name: h.name, open, archived: h.archived, codex: h.provider === 'codex' }, icon: <HistIcon />, name: h.name, snip: h.snippet,
        side: <><span>{baseName(h.cwd)}</span><span>{ago(h.lastModified)}</span></>,
      });
    });
    return !hits.length && searched.indexing ? 'Indexing past conversations…' : undefined;
  };

  if (page) {
    rows.push({ key: 'here-new', act: { path: page }, icon: <PlusIcon />, name: <span style={{ color: 'var(--muted)' }}>New session in {baseName(page)}</span> });
    roster.filter((x) => x.cwd === page && has(sessText(x))).sort((a, b) => rank(a.id, a.state) - rank(b.id, b.state)).forEach((x) => rows.push(openRow(x)));
    live.filter((x) => x.cwd === page && has(sessText(x))).forEach((x, i) => rows.push(pastRow(x, i === 0 ? 'Earlier' : undefined, false, false)));
    const hint = addHits();
    return { rows, hint, empty: q && !hint ? 'Nothing matches' : undefined };
  }

  if (mode === 'switch' && archived) {
    shownPast.filter((x) => x.archived && has(`${x.name} ${x.branch ?? ''} ${x.cwd}`)).forEach((x, i) =>
      rows.push({
        key: `p:${x.id}`, act: { resume: x.id }, section: i === 0 ? 'Archived' : undefined, sess: { id: x.id, name: x.name, open: false, archived: true, codex: x.provider === 'codex' },
        icon: <HistIcon />, name: x.name, meta: tilde(x.cwd, home), side: ago(x.lastModified),
      }),
    );
    const hint = addHits();
    return { rows, hint, empty: hint ? undefined : q ? 'Nothing matches' : 'No archived sessions' };
  }

  let hint: string | undefined;
  if (mode === 'switch' && byFolder) {
    // One block per folder: the current session's folder first, then by latest activity.
    const groups = new Map<string, { open: SessionSummary[]; past: PastSession[]; at: number }>();
    const group = (cwd: string) => groups.get(cwd) ?? groups.set(cwd, { open: [], past: [], at: 0 }).get(cwd)!;
    for (const x of roster) {
      const g = group(x.cwd);
      g.open.push(x);
      g.at = Math.max(g.at, x.id === current ? Infinity : x.lastActive);
    }
    for (const x of live) {
      const g = group(x.cwd);
      g.past.push(x);
      g.at = Math.max(g.at, x.lastModified);
    }
    for (const [cwd, g] of [...groups].sort((a, b) => b[1].at - a[1].at)) {
      const folderHit = has(`${baseName(cwd)} ${cwd}`);
      const open = g.open.filter((x) => folderHit || has(sessText(x))).sort((a, b) => rank(a.id, a.state) - rank(b.id, b.state));
      const old = g.past.filter((x) => folderHit || has(sessText(x)));
      if (!open.length && !old.length) continue;
      // A search shows its hits even inside a collapsed folder.
      const isOpen = !!q || !collapsed.includes(cwd);
      rows.push({
        key: `g:${cwd}`, act: { page: cwd }, enter: cwd, newHere: cwd, icon: <FolderIcon />, name: baseName(cwd), meta: tilde(cwd, home),
        side: count(g.open.length + g.past.length), group: { cwd, open: isOpen },
      });
      if (!isOpen) continue;
      const shown = [...open.map((x) => openRow(x, true)), ...old.map((x) => pastRow(x, undefined, true, false))];
      // Open sessions always show; past ones fill up to the limit.
      rows.push(...shown.slice(0, Math.max(open.length, GROUP_MAX)));
    }
    hint = addHits();
    // Typing also finds folders under home with no sessions yet; an exact name match goes on top.
    if (q && found && found.query === query.trim()) {
      const dirs = found.dirs.filter((d) => !groups.has(d.path)).slice(0, FOUND_MAX);
      const exact = dirs.filter((d) => fold(d.name) === q);
      const toRow = (d: (typeof dirs)[number], i: number, section: string): Row => ({
        key: `f:${d.path}`, act: { path: d.path }, section: i === 0 ? section : undefined,
        icon: <FolderIcon />, name: d.name, meta: tilde(d.path, home), side: d.branch ? <span className="mono">{d.branch}</span> : 'new session',
      });
      rows.unshift(...exact.map((d, i) => toRow(d, i, 'Start in this folder')));
      if (exact.length && rows.length > exact.length) rows[exact.length].section ??= 'Sessions';
      rows.push(...dirs.filter((d) => !exact.includes(d)).map((d, i) => toRow(d, i, 'Start in a folder')));
    }
  } else if (mode === 'switch') {
    roster.filter((x) => has(sessText(x))).sort((a, b) => rank(a.id, a.state) - rank(b.id, b.state)).forEach((x) => rows.push(openRow(x)));
    live.filter((x) => has(`${sessText(x)} ${x.cwd}`)).slice(0, MAX_PAST).forEach((x, i) => rows.push(pastRow(x, i === 0 ? 'Earlier' : undefined)));
    hint = addHits();
  }
  if (mode === 'switch') {
    if (current && has('Back to Start home')) {
      rows.push({ key: 'start', act: { start: true }, icon: <HomeIcon />, name: <span style={{ color: 'var(--muted)' }}>Back to Start</span> });
    }
    rows.push({
      key: 'new', act: { folder: true }, icon: <PlusIcon />,
      name: <span style={{ color: 'var(--muted)' }}>New session{q ? ` “${query.trim()}”` : ''}</span>,
      side: <><kbd style={{ margin: 0 }}>alt</kbd><kbd style={{ margin: 0 }}>N</kbd></>,
    });
    return { rows, hint };
  }

  if (!level) {
    folders.filter((f) => has(`${baseName(f.path)} ${f.path}`)).forEach((f, i) =>
      rows.push({
        key: `r:${f.path}`, act: folderAct(f.path), newHere: inFolder(f.path) ? f.path : undefined, section: i === 0 ? 'Recent folders' : undefined, enter: f.hasChildren ? f.path : undefined,
        icon: <FolderIcon />, name: baseName(f.path), meta: tilde(f.path, home), side: folderSide(f.path, f.branch),
      }),
    );
    // Typing a name also finds folders that had sessions and, a moment later, folders anywhere under home.
    if (q) {
      const seen = new Set(rows.map((r) => (r.act as { path?: string; page?: string }).path ?? (r.act as { page?: string }).page));
      const withSessions = [...new Set([...roster.map((r) => r.cwd), ...live.map((p) => p.cwd)])].filter((c) => c && !seen.has(c) && has(`${baseName(c)} ${c}`));
      withSessions.forEach((c, i) => {
        seen.add(c);
        rows.push({ key: `s:${c}`, act: folderAct(c), section: i === 0 ? 'Folders with sessions' : undefined, newHere: c, icon: <FolderIcon />, name: baseName(c), meta: tilde(c, home), side: folderSide(c, null) });
      });
      const hits = found && found.query === query.trim() ? found.dirs.filter((d) => !seen.has(d.path)) : [];
      const hitRow = (d: (typeof hits)[number], section?: string): Row => ({
        key: `f:${d.path}`, act: folderAct(d.path), section, enter: d.hasChildren ? d.path : undefined,
        newHere: inFolder(d.path) ? d.path : undefined, icon: <FolderIcon />, name: d.name, meta: tilde(d.path, home), side: folderSide(d.path, d.branch),
      });
      // A folder named exactly what was typed is the likely target, so it goes first.
      const exact = hits.filter((d) => fold(d.name) === q);
      rows.unshift(...exact.map((d, i) => hitRow(d, i === 0 ? 'Best match' : undefined)));
      hits.filter((d) => !exact.includes(d)).forEach((d, i) => rows.push(hitRow(d, i === 0 ? 'Found in home' : undefined)));
    }
    const roots = [...(home ? [{ path: home, name: 'Home' }] : []), { path: '/', name: 'Computer' }];
    roots.filter((b) => has(`${b.name} ${b.path}`)).forEach((b, i) =>
      rows.push({ key: `b:${b.path}`, act: { path: b.path }, section: i === 0 ? 'Browse' : undefined, enter: b.path, icon: <FolderIcon />, name: b.name, meta: tilde(b.path, home) }),
    );
    return { rows };
  }

  if (listing && 'error' in listing) return { rows, error: listing.error };
  if (!q) {
    rows.push({ key: 'here', act: { path: level }, icon: <HereIcon />, name: 'Start here', meta: tilde(level, home), side: listing?.branch && <span className="mono">{listing.branch}</span> });
    // The folder on screen shows its latest sessions under "Start here"; its page has them all.
    const here = live.filter((x) => x.cwd === level);
    here.slice(0, HERE_MAX).forEach((x, i) => rows.push(pastRow(x, i === 0 ? 'Sessions here' : undefined, false, false)));
    if (here.length > HERE_MAX) rows.push({ key: 'here-all', act: { page: level }, icon: <HistIcon />, name: <span style={{ color: 'var(--muted)' }}>All {count(here.length)}</span> });
  }
  const withSessions = rows.length > 1;
  for (const d of listing?.dirs ?? []) {
    if (!has(d.name)) continue;
    const section = withSessions && !rows.some((r) => r.section === 'Folders') ? 'Folders' : undefined;
    rows.push({ key: d.path, act: folderAct(d.path), newHere: inFolder(d.path) ? d.path : undefined, section, enter: d.hasChildren ? d.path : undefined, icon: <FolderIcon />, name: d.name, side: folderSide(d.path, d.branch) });
  }
  return { rows, empty: !listing ? undefined : q ? 'Nothing matches' : 'No subfolders' };
}

// AI picks go above the list and leave it, so a session never shows twice; the Ask AI row closes the results.
// note: the short line shown instead of the picks when there are none.
function useAi(base: Row[], query: string, page: string | null, offer: boolean): { rows: Row[]; note?: string } {
  const ai = useWhileOpen((s) => s.aiSearch);
  const roster = useWhileOpen((s) => s.roster);
  if (!offer) return { rows: base };
  const q = query.trim();
  const mine = ai && ai.query === q && ai.cwd === page ? ai : null;
  const picks = mine && !mine.pending ? mine.hits : [];
  const picked = new Set(picks.map((h) => h.id));
  const rows: Row[] = picks.map((h, i) => {
    const open = roster.some((r) => r.id === h.id);
    return {
      key: `a:${h.id}`, act: open ? { go: h.id } : { resume: h.id }, section: i === 0 ? 'AI picks' : undefined,
      sess: { id: h.id, name: h.name, open, archived: h.archived, codex: h.provider === 'codex' }, icon: <HistIcon />, name: h.name, snip: h.why,
      side: <><span>{baseName(h.cwd)}</span><span>{ago(h.lastModified)}</span></>,
    };
  });
  // A dropped row that opened a section hands its label to the next session row in it.
  let label: string | undefined;
  for (const r of base) {
    if (r.sess && picked.has(r.sess.id)) {
      label ??= r.section;
      continue;
    }
    rows.push(label && r.sess && !r.section ? { ...r, section: label } : r);
    label = undefined;
  }
  const at = rows.findIndex((r) => r.key === 'start' || r.key === 'new');
  rows.splice(at < 0 ? rows.length : at, 0, {
    key: 'ai', act: { ai: true }, icon: <SparkIcon />,
    name: <span className="ai-ask">{mine?.pending ? 'Asking AI…' : `Ask AI: “${q}”`}</span>,
    side: <><kbd style={{ margin: 0 }}>ctrl</kbd><kbd style={{ margin: 0 }}>↵</kbd></>,
  });
  return { rows, note: mine && !mine.pending && !picks.length ? (mine.error ?? 'No session fits') : undefined };
}

function Acts({ s, onRename, onArchive, onDelete }: { s: Sess; onRename: () => void; onArchive: () => void; onDelete: () => void }) {
  return (
    <span className="acts">
      {/* A closed session's palette closes once the server reopens it. */}
      {!s.archived && <WidgetButton id={s.id} open={s.open} onDone={() => s.open && setPalette(null)} />}
      {s.open && <button tabIndex={-1} aria-label="Close" title="Close (alt W)" onClick={stop(() => closeSession(s.id))}><XIcon /></button>}
      <button tabIndex={-1} aria-label="Rename" title="Rename (alt R)" onClick={stop(onRename)}><PencilIcon /></button>
      {s.archived
        ? <button className="txt" tabIndex={-1} title="Unarchive (alt A)" onClick={stop(onArchive)}><UnarchiveIcon />Unarchive</button>
        : <button tabIndex={-1} aria-label="Archive" title="Archive (alt A)" onClick={stop(onArchive)}><ArchiveIcon /></button>}
      <button tabIndex={-1} aria-label="Delete" title="Delete (alt ⌫, twice)" onClick={stop(onDelete)}><TrashIcon /></button>
    </span>
  );
}

// Combobox + listbox: the input keeps focus and the arrows move the selection.
export function Palette() {
  const mode = useStore((s) => s.palette);
  const notice = useWhileOpen((s) => s.notice);
  const home = useWhileOpen((s) => s.home);
  const dirs = useWhileOpen((s) => s.dirs);
  const archivedCount = useWhileOpen((s) => s.past.filter((p) => p.archived).length);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<{ dir: 1 | -1; ghost: HTMLElement } | null>(null);
  const [query, setQuery] = useState('');
  const carry = useRef('');
  const [sel, setSel] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // Folder levels entered from the picker's root, outermost first.
  const [levels, setLevels] = useState<string[]>([]);
  const [byFolder, setByFolder] = useState(() => pref.get('palette.byFolder', true));
  const [collapsed, setCollapsed] = useState(() => pref.get<string[]>('palette.collapsed', []));
  const toggleGroup = (cwd: string) => {
    const next = collapsed.includes(cwd) ? collapsed.filter((c) => c !== cwd) : [...collapsed, cwd];
    pref.set('palette.collapsed', next);
    setCollapsed(next);
    inputRef.current!.focus();
  };
  // A folder's page sits on top of whichever list opened it; back returns there.
  const [page, setPageState] = useState<string | null>(null);
  const pageRef = useRef<string | null>(null);
  const setPage = (v: string | null) => {
    pageRef.current = v;
    setPageState(v);
  };
  const [armed, press] = useArm();
  // The folder step opened from the list can go back; opened from New it stands alone.
  const [canBack, setCanBackState] = useState(false);
  const canBackRef = useRef(false);
  const setCanBack = (v: boolean) => {
    canBackRef.current = v;
    setCanBackState(v);
  };
  const shownMode = mode ?? 'switch';
  const folder = shownMode === 'folder';
  const level = folder ? levels.at(-1) : undefined;
  const listed = useRows(shownMode, query, showArchived && !page, page ? undefined : level, byFolder, page, collapsed);
  const { error, empty, hint } = listed;
  // AI search is offered wherever content search runs, except the archived list.
  const offer = !!mode && (!!page || (mode === 'switch' && !showArchived)) && query.trim().length >= 2;
  const { rows, note: aiNote } = useAi(listed.rows, query, page, offer);
  const selected = Math.max(0, Math.min(rows.length - 1, sel));

  const fades = () => {
    const l = listRef.current!;
    l.classList.toggle('mt', l.scrollTop > 2);
    l.classList.toggle('mb', l.scrollTop + l.clientHeight < l.scrollHeight - 2);
  };

  useEffect(() => {
    const d = dialogRef.current!;
    setLevels([]);
    setPage(mode ? useStore.getState().paletteAt : null);
    setShowArchived(false);
    setEditing(null);
    if (!mode) {
      if (d.open) d.close();
      setCanBack(false);
      return;
    }
    if (!d.open) {
      d.showModal();
      send({ type: 'list-past', fresh: true });
    }
    // "New session" carries what was typed into the folder picker's search.
    setQuery(carry.current);
    carry.current = '';
    setSel(0);
    inputRef.current!.focus();
    listRef.current!.scrollTop = 0;
  }, [mode]);

  // Folder search under home, once typing pauses; the switch list uses it to offer new folders.
  const searchFor = (folder ? !level : byFolder && !showArchived) && !page ? query.trim() : '';
  useEffect(() => {
    if (searchFor.length < 2) return;
    const t = setTimeout(() => send({ type: 'find-dirs', query: searchFor }), 180);
    return () => clearTimeout(t);
  }, [searchFor]);

  // Content search over saved conversations; while the first index build runs, each answer asks again a bit later.
  const searchText = mode === 'switch' || page ? query.trim() : '';
  const building = useStore((s) => (s.searched?.indexing && s.searched.query === searchText && s.searched.cwd === page ? s.searched : null));
  useEffect(() => {
    if (searchText.length < 2) return;
    const t = setTimeout(() => send({ type: 'search', query: searchText, ...(page ? { cwd: page } : {}) }), building ? 2000 : 180);
    return () => clearTimeout(t);
  }, [searchText, page, building]);

  // AI search runs only when asked; its answer belongs to one query and folder and clears when either changes.
  function askAi() {
    const a = useStore.getState().aiSearch;
    if (!offer || (a?.pending && a.query === searchText && a.cwd === page)) return;
    useStore.setState({ aiSearch: { query: searchText, cwd: page, pending: true, hits: [] } });
    send({ type: 'search-ai', query: searchText, ...(page ? { cwd: page } : {}) });
  }
  useEffect(() => {
    const a = useStore.getState().aiSearch;
    if (!a || (a.query === searchText && a.cwd === page)) return;
    if (a.pending) send({ type: 'search-ai-stop' });
    useStore.setState({ aiSearch: null });
  }, [searchText, page]);
  // The answer shows at the top of the list, so the list goes there.
  const aiPending = useStore((s) => s.aiSearch?.pending);
  useEffect(() => {
    if (aiPending !== false) return;
    setSel(0);
    listRef.current!.scrollTop = 0;
  }, [aiPending]);

  useLayoutEffect(() => {
    document.getElementById(`po${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows.length, query, mode, page, levels]);
  // Fades are read in the observer callback, which also fires once on each new list.
  useEffect(() => {
    const ro = new ResizeObserver(fades);
    ro.observe(listRef.current!);
    return () => ro.disconnect();
  }, [rows.length, query, mode, page, levels, showArchived, collapsed]);

  // The page that was on screen is cloned and slides out while the new one slides in.
  useLayoutEffect(() => {
    const s = slideRef.current;
    slideRef.current = null;
    if (!s) return;
    const body = bodyRef.current!;
    const fwd = s.dir === 1;
    s.ghost.style.zIndex = fwd ? '0' : '2';
    body.animate(fwd ? [{ transform: 'translateX(100%)' }, { transform: 'none' }] : [{ transform: 'translateX(-30%)', opacity: 0 }, { transform: 'none', opacity: 1 }], SLIDE);
    const out = s.ghost.animate(fwd ? [{ transform: 'none', opacity: 1 }, { transform: 'translateX(-30%)', opacity: 0 }] : [{ transform: 'none' }, { transform: 'translateX(100%)' }], SLIDE);
    out.onfinish = out.oncancel = () => s.ghost.remove();
  }, [levels, page]);

  useEffect(() => {
    const d = dialogRef.current!;
    // A late close event from Esc must not shut a palette that was reopened meanwhile.
    const onClose = () => !d.open && useStore.getState().palette && setPalette(null);
    // Esc steps back one level; a click outside (light dismiss, no key) closes the whole palette.
    // An Esc another handler swallowed must not count for a later click outside, so it expires fast.
    let escAt = 0;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') escAt = performance.now();
    };
    const onCancel = (e: Event) => {
      const key = performance.now() - escAt < 200;
      escAt = 0;
      if (!key) return setPalette(null);
      if (document.activeElement?.closest('.prow')) return e.preventDefault();
      if (pageRef.current) {
        e.preventDefault();
        leavePage(false);
      } else if (useStore.getState().palette === 'folder' && canBackRef.current) {
        e.preventDefault();
        toSwitch();
      } else setPalette(null);
    };
    d.addEventListener('close', onClose);
    d.addEventListener('keydown', onKey, true);
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('close', onClose);
      d.removeEventListener('keydown', onKey, true);
      d.removeEventListener('cancel', onCancel);
    };
  }, []);
  function toSwitch() {
    setCanBack(false);
    setPalette('switch');
  }

  function startSlide(dir: 1 | -1) {
    const body = bodyRef.current!;
    body.parentElement!.querySelectorAll('.pal-body.ghost').forEach((g) => g.remove());
    const ghost = body.cloneNode(true) as HTMLElement;
    ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    ghost.classList.add('ghost');
    ghost.inert = true;
    Object.assign(ghost.style, { left: `${body.offsetLeft}px`, top: `${body.offsetTop}px`, width: `${body.offsetWidth}px`, height: `${body.offsetHeight}px` });
    body.after(ghost);
    ghost.querySelector('.pal-list')!.scrollTop = listRef.current!.scrollTop;
    slideRef.current = { dir, ghost };
  }

  // Keyboard moves are frequent, so they swap pages without the slide.
  function goTo(next: string[], dir: 1 | -1, animate: boolean, rest = '') {
    if (animate && !reduceMotion()) startSlide(dir);
    setLevels(next);
    setQuery(rest);
    setSel(0);
    const at = next.at(-1);
    if (at) listDirs(at);
    listRef.current!.scrollTop = 0;
    inputRef.current!.focus();
  }
  const enter = (path: string, animate: boolean) => goTo([...levels, path], 1, animate);
  function openPage(path: string, animate: boolean) {
    if (animate && !reduceMotion()) startSlide(1);
    setPage(path);
    useStore.setState({ folder: path });
    setQuery('');
    setSel(0);
    listRef.current!.scrollTop = 0;
    inputRef.current!.focus();
  }
  function leavePage(animate: boolean) {
    if (animate && !reduceMotion()) startSlide(-1);
    setPage(null);
    setQuery('');
    setSel(0);
    inputRef.current!.focus();
  }
  const up = (animate: boolean) => goTo(levels.slice(0, -1), -1, animate);

  // "~/", "/mnt/", "work/" (relative to the folder on screen) jump to that folder's listing.
  function jump(typed: string) {
    const cut = typed.lastIndexOf('/');
    const target = resolvePath(typed.slice(0, cut + 1), level ?? home, home);
    const i = levels.indexOf(target);
    const next = i >= 0 ? levels.slice(0, i + 1) : level && parentOf(target) === level ? [...levels, target] : chainTo(target, home);
    goTo(next, 1, false, typed.slice(cut + 1));
  }

  function run(act: Action, animate = true) {
    if ('ai' in act) askAi();
    else if ('page' in act) openPage(act.page, animate);
    else if ('folder' in act) {
      carry.current = query.trim();
      setCanBack(true);
      setPalette('folder');
    } else if ('go' in act) {
      setPalette(null);
      openSession(act.go);
    } else if ('start' in act) {
      setPalette(null);
      showStart();
    } else if ('resume' in act) {
      send({ type: 'resume', id: act.resume });
    } else {
      send({ type: 'open', cwd: act.path, ...useStore.getState().defaults });
    }
  }

  const sessionActs = (s: Sess) => ({
    onRename: () => setEditing(s.id),
    onArchive: () => setArchived(s.id, !s.archived),
    onDelete: () => press(s.id) && deleteSession(s.id),
  });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const row = rows[selected];
    if (e.altKey && (!folder || page) && ['KeyW', 'KeyR', 'KeyA', 'Backspace'].includes(e.code)) {
      e.preventDefault();
      const s = row?.sess;
      if (!s) return;
      const a = sessionActs(s);
      if (e.code === 'KeyW') return s.open && closeSession(s.id);
      if (e.code === 'KeyR') return a.onRename();
      if (e.code === 'KeyA') return a.onArchive();
      return a.onDelete();
    }
    const input = e.currentTarget;
    const atEnd = input.selectionStart === query.length;
    if (page && (e.key === 'ArrowLeft' || e.key === 'Backspace') && !query) {
      e.preventDefault();
      leavePage(false);
    } else if (!page && (e.key === 'Tab' || e.key === 'ArrowRight') && !e.shiftKey && atEnd && row?.act && 'page' in row.act && !folder) {
      e.preventDefault();
      openPage(row.act.page, false);
    } else if (folder && !page && ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'ArrowRight' && atEnd))) {
      if (e.key === 'Tab' || row?.enter) e.preventDefault();
      if (row?.enter) enter(row.enter, false);
    } else if (folder && (e.key === 'ArrowLeft' || e.key === 'Backspace') && !query && levels.length) {
      e.preventDefault();
      up(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(selected + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(selected - 1);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      askAi();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (row) run(row.act, false);
    } else if (e.key === 'Backspace' && !query && mode === 'folder' && canBack) toSwitch();
  };

  const onQuery = (v: string) => {
    if (notice) useStore.setState({ notice: null });
    if (folder && v.includes('/')) return jump(v);
    setQuery(v);
    setSel(0);
  };

  const toggleFolders = () => {
    pref.set('palette.byFolder', !byFolder);
    setByFolder(!byFolder);
    setSel(0);
    inputRef.current!.focus();
  };

  const toggleArchived = () => {
    setShowArchived(!showArchived);
    setSel(0);
    inputRef.current!.focus();
  };

  const placeholder = page
    ? `Search sessions in ${baseName(page)}…`
    : folder
    ? level ? `Filter ${levelLabel(level, home)}, or type a path…` : 'Pick a folder, or type a path…'
    : showArchived ? 'Search archived…' : 'Switch session…';

  return (
    <dialog className={`pal${folder ? ' folder' : ''}`} ref={dialogRef} closedby="any" aria-label="Sessions">
      <div className="pal-top">
        <span className="crumb">New session</span>
        <input
          ref={inputRef} role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list" autoComplete="off" spellCheck={false}
          aria-label={placeholder} placeholder={placeholder} aria-activedescendant={rows.length ? `po${selected}` : ''}
          value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKeyDown}
        />
        {!folder && !page && !showArchived && (
          <button className="afilt" aria-pressed={byFolder} onClick={toggleFolders} title="Group sessions by folder">
            <FolderIcon />Folders
          </button>
        )}
        {!folder && !page && !showArchived && (
          <button className="afilt" onClick={() => run({ folder: true })} title="Start a session in a folder (alt N)">
            <PlusIcon />New
          </button>
        )}
        {!folder && !page && (archivedCount > 0 || showArchived) && (
          <button className="afilt" aria-pressed={showArchived} onClick={toggleArchived} title="Show archived sessions">
            <ArchiveIcon />Archived<span className="k">{archivedCount}</span>
          </button>
        )}
        <button className="sh-x" aria-label="Close" onClick={() => setPalette(null)}><kbd>esc</kbd></button>
      </div>
      <div className="pal-body" ref={bodyRef}>
        {page ? (
          <div className="fhead">
            <button className="back" aria-label="Back" title="Back (←)" onClick={() => leavePage(true)}><ChevLeft /></button>
            <nav className="crumbs" aria-label="Folder">
              <span className="cr" aria-current="location" title={tilde(page, home)}>{baseName(page)}</span>
              <span className="csep" aria-hidden="true">·</span>
              <span className="cpath mono">{tilde(page, home)}</span>
            </nav>
          </div>
        ) : level && (
          <div className="fhead">
            <button className="back" aria-label="Back" title="Back (←)" onClick={() => up(true)}><ChevLeft /></button>
            <nav className="crumbs" aria-label="Folder path">
              {levels.map((p, i) => (
                <Fragment key={p}>
                  {i > 0 && <span className="csep" aria-hidden="true">›</span>}
                  {i === levels.length - 1
                    ? <span className="cr" aria-current="location" title={tilde(p, home)}>{levelLabel(p, home)}</span>
                    : <button className="cr" title={tilde(p, home)} onClick={() => goTo(levels.slice(0, i + 1), -1, true)}>{levelLabel(p, home)}</button>}
                </Fragment>
              ))}
            </nav>
          </div>
        )}
        <div className="pal-list" id="palList" role="listbox" ref={listRef} onScroll={fades}>
          {notice && <div className="pal-empty err" role="alert">{notice}</div>}
          {error && <div className="pal-empty err" role="alert">{error}</div>}
          {aiNote && <div className="pal-hint ai-note" role="status">{aiNote}</div>}
          {rows.map((r, k) => {
            const isArmed = !!r.sess && armed === r.sess.id;
            return (
              <Fragment key={r.key}>
                {r.section && <div className="pg3">{r.section}</div>}
                <div
                  className={`prow${isArmed ? ' armed' : ''}${r.sub ? ' sub' : ''}${r.snip !== undefined ? ' hit' : ''}`} role="option" id={`po${k}`} aria-selected={k === selected}
                  onMouseMove={() => k !== selected && setSel(k)} onClick={() => run(r.act)}
                >
                  {r.group ? (
                    <button
                      className="gfold" tabIndex={-1} aria-expanded={r.group.open} aria-label={`${r.group.open ? 'Collapse' : 'Expand'} ${baseName(r.group.cwd)}`}
                      title={r.group.open ? 'Collapse' : 'Expand'} disabled={!!query.trim()} onClick={stop(() => toggleGroup(r.group!.cwd))}
                    >
                      {r.icon}<ChevRight />
                    </button>
                  ) : r.icon}
                  {r.sess && editing === r.sess.id ? (
                    <RenameInput
                      className="pn ren" value={r.sess.name}
                      onDone={(name) => { if (name) renameSession(r.sess!.id, name); setEditing(null); inputRef.current?.focus(); }}
                    />
                  ) : <span className="pn">{r.name}</span>}
                  {r.sess?.codex && <CodexTag />}
                  {isArmed
                    ? <span className="pb">also gone from claude --resume</span>
                    : r.snip !== undefined ? <span className="pb snip"><Snippet text={r.snip} /></span> : <span className="pb mono">{r.meta}</span>}
                  <span className={`pr${r.warn ? ' w' : ''}`}>
                    {r.side !== undefined && <span className="tm">{r.side}</span>}
                    {r.newHere && (
                      <button className="newh" tabIndex={-1} title={`New session in ${baseName(r.newHere)}`} onClick={stop(() => run({ path: r.newHere! }))}>
                        <PlusIcon />New
                      </button>
                    )}
                    {r.sess && (isArmed
                      ? <button className="arm" tabIndex={-1} onClick={stop(() => press(r.sess!.id) && deleteSession(r.sess!.id))}>Delete forever?</button>
                      : <Acts s={r.sess} {...sessionActs(r.sess)} />)}
                    <Ent />
                  </span>
                  {(folder || byFolder || page) && !showArchived && (
                    <span className="go-slot">
                      {r.enter && (
                        <button
                          className="go" tabIndex={-1} aria-label={`${folder && !page ? 'Show folders in' : 'Sessions in'} ${typeof r.name === 'string' ? r.name : 'this folder'}`}
                          onPointerEnter={() => folder && !page && !dirs[r.enter!] && listDirs(r.enter!)}
                          onClick={stop(() => (folder && !page ? enter(r.enter!, true) : openPage(r.enter!, true)))}
                        ><ChevRight /></button>
                      )}
                    </span>
                  )}
                </div>
              </Fragment>
            );
          })}
          {hint && <div className="pal-hint">{hint}</div>}
          {!rows.length && !error && empty !== undefined && <div className="pal-empty">{empty}</div>}
          {!rows.length && !error && empty === undefined && !level && !hint && <div className="pal-empty">Nothing matches</div>}
        </div>
      </div>
      <div className="pal-foot">
        {page
          ? <><kbd>↑↓</kbd>pick<kbd>↵</kbd>open<kbd>←</kbd>back</>
          : folder
          ? <><kbd>↑↓</kbd>pick<kbd>→</kbd>browse{level && <><kbd>←</kbd>up</>}<kbd>↵</kbd>start<kbd>esc</kbd>{canBack ? 'back' : 'close'}</>
          : <><kbd>↵</kbd>open{!showArchived && <><kbd>alt W</kbd>close</>}<kbd>alt R</kbd>rename<kbd>alt A</kbd>{showArchived ? 'unarchive' : 'archive'}<kbd>alt ⌫</kbd>delete</>}
      </div>
    </dialog>
  );
}
