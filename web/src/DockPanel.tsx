import { Fragment, Suspense, lazy, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { sessionOrder, useStore } from './store.ts';
import { flushSync } from 'react-dom';
import { send } from './socket.ts';
import { newKey, openNew, resumeKey, resumeSession } from './actions.ts';
import { BranchIcon, Chev, CodexTag, RenameInput, XIcon, ago, baseName, pref } from './bits.tsx';
import { HistIcon } from './SessionMenu.tsx';
import { FolderIcon, TermIcon, needsYou, subLabel, termState, termTone } from './DockFolders.tsx';
import { reduceMotion } from './perf.ts';
import { ownsCtrlKeys } from './appWindow.ts';
import { usePins } from './prefs.ts';
import { SessionTile } from './sessionColor.tsx';
import { TabPhone } from './Remote.tsx';
import { terminalName } from './terminal.ts';
import type { LedPattern } from './led.tsx';
import type { GroupMember, GroupState, PastSession, SessionSummary, TerminalSession } from '../../server/protocol.ts';

const SubsessionDialog = lazy(() => import('./SubsessionDialog.tsx'));

// Closed sessions listed under the open tabs fill the room left in the list, within these; All in the footer reaches the rest.
const PAST_MIN = 6;
const PAST_CAP = 30;
// Name matches from closed sessions shown by a search; the content hits come capped by the server.
const FIND_PAST = 30;
// Same folded form as the palette's, so "area" finds "Área".
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export type PanelProps = {
  folder: string | null;
  past: PastSession[];
  term: TerminalSession[];
  current: string | null;
  pending: string | null;
  menuId: string | null;
  editing: string | null;
  armed: string | null;
  curPattern: LedPattern;
  onPick: (id: string) => void;
  onMenu: (e: MouseEvent<HTMLElement>, id: string, past?: boolean) => void;
  onClose: (id: string) => void;
  onAux: (e: MouseEvent, id: string) => void;
  onRenamed: (id: string, name: string | null) => void;
};

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
);
const FindIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="5.6" cy="5.6" r="3.9" /><path d="m8.6 8.6 3 3" /></svg>
);
// The server wraps each match in \u0002 and \u0003.
const Snippet = ({ text }: { text: string }) => text.split('\u0002').map((part, i) => {
  const end = part.indexOf('\u0003');
  if (!i || end < 0) return <Fragment key={i}>{part.replace('\u0003', '')}</Fragment>;
  return <Fragment key={i}><mark>{part.slice(0, end)}</mark>{part.slice(end + 1)}</Fragment>;
});

// "<$0.01" and "$1.24" like the usage popover; a provider that reports no cost shows none, never $0.00.
const money = (v: number | null | undefined) => (typeof v !== 'number' ? null : v > 0 && v < 0.005 ? '<$0.01' : `$${v.toFixed(2)}`);

// The reply's tail as one line: its last non-empty line without list, quote or emphasis marks.
function oneLine(text: string | undefined) {
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.replace(/^\s*(?:[#>*\-•]+|\d+\.)\s*/, '').replace(/\*\*|__|`/g, '').trim());
  return lines.filter(Boolean).pop() ?? '';
}

type Where = { cwd: string; folder?: string; branch: string | null; worktree: boolean };

// Group headers own the folder label; flat search results still need their location.
function Place({ w, cost, grouped = false, mainName }: { w: Where; cost?: string | null; grouped?: boolean; mainName?: string }) {
  const branch = w.branch;
  if (grouped && !w.worktree && !branch && !cost && !mainName) return null;
  return (
    <span className="dp-l2">
      {!grouped && <span className="dp-f">{baseName(w.folder ?? w.cwd)}</span>}
      {!grouped && (w.worktree || branch) && <span className="dp-sep" aria-hidden="true">·</span>}
      {w.worktree && <span className="dp-wt" title={baseName(w.cwd)}>worktree</span>}
      {branch && (
        <>
          <BranchIcon />
          <span className="dp-br">{branch}</span>
        </>
      )}
      {mainName && <span className="dp-parent" title={mainName}>↳ {mainName}</span>}
      {cost && <span className="dp-cost" title="Cost reported by the provider">{cost}</span>}
    </span>
  );
}

// brief: name, state and place only, for sessions listed away from their folder's tree. n: its Ctrl/Alt+digit number.
type RowProps = Omit<PanelProps, 'folder' | 'past' | 'term' | 'curPattern'> & {
  id: string; index: number; member?: GroupMember; onSub?: (s: SessionSummary) => void;
  brief?: boolean; n?: number; grouped?: boolean; curPattern?: LedPattern; mainName?: string;
};

const Live = memo(function Live({ id, index, member, onSub, brief, n, grouped, mainName, ...p }: RowProps) {
  // The memoized roster index keeps each row's subscription constant-time.
  const s = useStore((state) => state.roster[index]?.id === id ? state.roster[index] : undefined);
  if (!s) return null;
  const cur = s.id === p.current;
  const need = needsYou(s);
  const tone = need ? ' needs' : s.state === 'done' ? ' done' : '';
  const state = subLabel(s);
  // While a turn runs, what it is doing; otherwise the end of its last reply.
  const doing = s.state === 'working' && !need ? s.activity : '';
  const reply = doing || oneLine(s.lastReply);
  const wt = member?.worktree;
  const where = { cwd: s.cwd, folder: s.worktreeRepo ?? wt?.sourceCwd, branch: wt?.branch ?? s.branch, worktree: !!wt || !!s.worktree };
  const armed = p.armed === s.id;
  const tile = <SessionTile id={s.id} state={s.state} needsYou={s.needsYou} background={s.background} pattern={cur ? p.curPattern : undefined} />;
  const key = n && n <= 9 ? `${ownsCtrlKeys() ? 'Ctrl' : 'Alt'}+${n}` : undefined;
  const body = (
    <>
      {tile}
      {key && <span className="dp-n" title={key} aria-hidden="true">{n}</span>}
      <span className="dp-l1">
        {p.editing === s.id ? (
          <RenameInput className="dp-nm" value={s.name} onDone={(name) => p.onRenamed(s.id, name)} />
        ) : (
          <span className="dp-nm" dir="auto">{s.name}</span>
        )}
        {s.provider === 'codex' && <CodexTag />}
        {s.remote && <TabPhone state={s.remote.state} />}
        <span className={`dp-st${tone}`} title={state}>{state}</span>
      </span>
      <Place w={where} cost={money(s.cost)} grouped={grouped} mainName={mainName} />
      {reply && !brief && <span className={`dp-l3${doing ? ' doing' : ''}`} dir="auto" title={reply}>{reply}</span>}
    </>
  );
  return (
    <div className={`dp-row${cur ? ' cur' : ''}`} data-k={s.id} data-menu={p.menuId === s.id ? '' : undefined} data-arm={armed ? '' : undefined}>
      {p.editing === s.id ? (
        <div className="dp-main editing" aria-current={cur ? 'page' : undefined}>{body}</div>
      ) : (
        <button
          type="button" className="dp-main" aria-current={cur ? 'page' : undefined} title={s.name} aria-keyshortcuts={key?.replace('Ctrl', 'Control')}
          onClick={() => p.onPick(s.id)} onContextMenu={(e) => p.onMenu(e, s.id)} onAuxClick={(e) => p.onAux(e, s.id)} onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        >
          {body}
        </button>
      )}
      <span className="dp-acts">
        {onSub && (
          <button type="button" className="dp-add" aria-label={`New sub-session of ${s.name}`} title="New sub-session" onClick={() => onSub(s)}><PlusIcon /></button>
        )}
        <button
          type="button" className="dp-x" aria-label={armed ? `Stop and close ${s.name}` : `Close ${s.name}`} title={armed ? 'Click again to stop it and close' : 'Close (alt W)'}
          onClick={() => p.onClose(s.id)}
        ><XIcon /></button>
      </span>
      {armed && <span className="dp-arm" role="status">Stop and close? Click again</span>}
    </div>
  );
});

// A group member whose tab is closed; it reopens from its saved conversation when there is one.
// Right-click opens the same menu as a Recent row, when there is a saved conversation.
const Closed = memo(function Closed({ m, p, grouped = false }: { m: GroupMember; p: PanelProps; grouped?: boolean }) {
  const id = m.savedId;
  const busy = !!id && p.pending === resumeKey(id);
  return (
    <div className="dp-row closed" data-k={m.id} data-menu={id && p.menuId === id ? '' : undefined}>
      <button
        type="button" className="dp-main" aria-disabled={!id || undefined} aria-busy={busy || undefined}
        title={id ? `${m.name} · Closed, click to reopen` : `${m.name} · Closed, no saved conversation to reopen`} onClick={() => id && resumeSession(id)}
        onContextMenu={(e) => (id ? p.onMenu(e, id, true) : e.preventDefault())}
      >
        <span className="dp-ic">{busy ? <span className="g spin"></span> : <HistIcon />}</span>
        <span className="dp-l1">
          <span className="dp-nm" dir="auto">{m.name}</span>
          {m.provider === 'codex' && <CodexTag />}
          <span className="dp-st">{id ? 'closed' : 'no history'}</span>
        </span>
        <Place w={{ cwd: m.cwd, branch: m.worktree?.branch ?? null, worktree: !!m.worktree }} grouped={grouped} />
      </button>
    </div>
  );
});

// A closed session; it reopens from its saved conversation. place adds its folder, snip the text a search matched.
function Past({ x, p, place, snip }: { x: PastSession; p: PanelProps; place?: boolean; snip?: string }) {
  const busy = p.pending === resumeKey(x.id);
  return (
    <div className="dp-row past" data-k={x.id} data-menu={p.menuId === x.id ? '' : undefined}>
      <button
        type="button" className="dp-main" title={x.name} aria-busy={busy || undefined}
        onClick={() => resumeSession(x.id)} onContextMenu={(e) => p.onMenu(e, x.id, true)}
      >
        <span className="dp-ic">{busy ? <span className="g spin"></span> : <HistIcon />}</span>
        <span className="dp-l1">
          <span className="dp-nm" dir="auto">{x.name}</span>
          {x.provider === 'codex' && <CodexTag />}
          <span className="dp-st">{ago(x.lastModified)}</span>
        </span>
        {place && <Place w={{ cwd: x.cwd, branch: x.branch, worktree: false }} />}
        {snip && <span className="dp-l3 dp-snip" dir="auto"><Snippet text={snip} /></span>}
      </button>
    </div>
  );
}

type FolderRow = { id: string; index: number; member?: GroupMember; worktree: boolean };
type Entry = { row: FolderRow; children: FolderRow[]; group?: GroupState; mainName?: string; busy: boolean };
type FolderGroup = { cwd: string; count: number; rank: number; busy: boolean; entries: Entry[] };

// Background agents count too: the session still has work running.
const busy = (s: SessionSummary) => s.state === 'working' || s.background || needsYou(s);
// Collapsed folder groups, kept in this browser.
const COLLAPSED_KEY = 'dock.collapsed';
const EASE = 'cubic-bezier(.23,1,.32,1)';
// A row's top inside the list, ignoring transforms, so a running slide never skews the next one.
function topIn(el: HTMLElement, root: HTMLElement) {
  let y = 0;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
  return y;
}
function measure(root: HTMLElement) {
  return new Map([...root.querySelectorAll<HTMLElement>('[data-flip]')].map((el) => [el.dataset.flip!, topIn(el, root)]));
}

export default function DockPanel(p: PanelProps) {
  const roster = useStore((s) => s.roster);
  const dockOrder = useStore((s) => s.dockOrder);
  const pins = usePins();
  const groups = useStore((s) => s.groups);
  const allPast = useStore((s) => s.past);
  const [creating, setCreating] = useState<SessionSummary | null>(null);
  const [query, setQuery] = useState('');
  const q = query.trim();
  const found = useStore((s) => (s.searched?.query === q && s.searched.cwd === null ? s.searched : null));
  const [fill, setFill] = useState(PAST_MIN);
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const recentRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(() => new Set(pref.get<string[]>(COLLAPSED_KEY, [])));
  const flipRef = useRef(new Map<string, number>());
  useEffect(() => pref.set(COLLAPSED_KEY, [...collapsed]), [collapsed]);
  const toggleFolder = (cwd: string, rows: Element | null) => {
    const close = !collapsed.has(cwd);
    const apply = () => setCollapsed((cur) => {
      const next = new Set(cur);
      if (close) next.add(cwd);
      else next.delete(cwd);
      return next;
    });
    // Closing fades the rows out first; the rows below then slide up in the layout effect.
    if (!close || !rows || reduceMotion()) return apply();
    const fade = rows.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 120, easing: 'ease-out', fill: 'forwards' });
    // Commit before dropping the fill, so rows that stay mounted (the folder became current) never stay invisible.
    const done = () => {
      flushSync(apply);
      fade.cancel();
    };
    fade.finished.then(done, done);
  };
  const { open, indices, num, folders, treeHistory, folderOf } = useMemo(() => {
    const open = new Map(roster.map((r) => [r.id, r]));
    const indices = new Map(roster.map((r, i) => [r.id, i]));
    const order = sessionOrder({ roster, dockOrder }, pins);
    const num = new Map(order.map((id, i) => [id, i + 1]));
    const members = new Map<string, GroupMember>();
    const groupOf = new Map<string, GroupState>();
    const repos = new Map<string, string>();
    for (const g of groups) for (const m of [g.main, ...g.children]) {
      members.set(m.id, m);
      groupOf.set(m.id, g);
      if (m.worktree?.sourceCwd) repos.set(m.cwd, m.worktree.sourceCwd);
    }
    for (const r of roster) if (r.worktreeRepo) repos.set(r.cwd, r.worktreeRepo);
    const folderOf = new Map<string, string>();
    const buckets = new Map<string, { folder: FolderGroup; rows: FolderRow[] }>();
    const treeHistory = new Set<string>();
    // Closed members remain reachable with their group, including a closed main session.
    const closed = groups.filter((g) => [g.main, ...g.children].some((m) => open.has(m.id)))
      .flatMap((g) => [g.main, ...g.children]).filter((m) => !open.has(m.id));
    const placeOf = (id: string) => {
      const s = open.get(id);
      const path = s?.cwd ?? members.get(id)!.cwd;
      return s?.worktreeRepo ?? members.get(id)?.worktree?.sourceCwd ?? repos.get(path) ?? path;
    };
    for (const id of [...order, ...closed.map((m) => m.id)]) {
      const s = open.get(id);
      const member = members.get(id);
      // A sub-session sits under its main session, even when its worktree belongs to another repo.
      const main = groupOf.get(id)?.main.id;
      const cwd = placeOf(main ?? id);
      folderOf.set(id, cwd);
      let bucket = buckets.get(cwd);
      if (!s && !bucket) continue;
      if (!bucket) {
        bucket = { folder: { cwd, count: 0, rank: Infinity, busy: false, entries: [] }, rows: [] };
        buckets.set(cwd, bucket);
      }
      if (s) {
        bucket.folder.count++;
        bucket.folder.rank = Math.min(bucket.folder.rank, num.get(id)!);
        if (busy(s)) bucket.folder.busy = true;
      }
      bucket.rows.push({ id, index: indices.get(id) ?? -1, member, worktree: !!s?.worktree || !!member?.worktree });
      if (member?.savedId) treeHistory.add(member.savedId);
    }
    // Working or waiting sessions come first; the dock order breaks ties.
    const isBusy = (id: string) => { const s = open.get(id); return !!s && busy(s); };
    const byWork = (a: FolderRow, b: FolderRow) => Number(isBusy(b.id)) - Number(isBusy(a.id)) || (num.get(a.id) ?? Infinity) - (num.get(b.id) ?? Infinity);
    for (const { folder, rows } of buckets.values()) {
      const byId = new Map(rows.map((row) => [row.id, row]));
      const seen = new Set<string>();
      for (const row of rows) {
        const group = groupOf.get(row.id);
        const main = group && byId.get(group.main.id);
        if (!group || !main) {
          folder.entries.push({ row, children: [], mainName: group?.main.name, busy: isBusy(row.id) });
          continue;
        }
        if (seen.has(group.id)) continue;
        seen.add(group.id);
        const children = group.children.flatMap((m) => byId.get(m.id) ?? []).sort(byWork);
        folder.entries.push({ row: main, children, group, busy: isBusy(main.id) || children.some((c) => isBusy(c.id)) });
      }
      folder.entries.sort((a, b) => Number(b.busy) - Number(a.busy));
    }
    const folders = [...buckets.values()].map((b) => b.folder).sort((a, b) => Number(b.busy) - Number(a.busy) || a.rank - b.rank);
    return { open, indices, num, folders, treeHistory, folderOf };
  }, [roster, dockOrder, pins, groups]);
  const here = folders.find((f) => f.cwd === p.folder);
  const others = folders.filter((f) => f !== here);
  const orderedFolders = here ? [here, ...others] : others;
  const { folder: _folder, past: _past, term: _term, curPattern: _pattern, ...liveProps } = p;
  const past = p.past.filter((s) => !treeHistory.has(s.id)).slice(0, fill);

  // Opening a session in another folder moves that folder to the top, so the list scrolls up to follow it.
  const lastFolder = useRef(p.folder);
  useEffect(() => {
    if (lastFolder.current === p.folder) return;
    lastFolder.current = p.folder;
    const list = listRef.current;
    if (list && list.scrollTop > 0) list.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
  }, [p.folder]);

  // FLIP: folders and session blocks slide from where they were when the order or a folder's open state changes.
  const layout = q ? '' : orderedFolders.map((f) => `${f.cwd}:${collapsed.has(f.cwd) ? '-' : f.entries.map((e) => [e.row.id, ...e.children.map((c) => c.id)].join('.')).join(',')}`).join('|');
  useLayoutEffect(() => {
    const root = innerRef.current;
    if (!root) return;
    const was = flipRef.current;
    const now = measure(root);
    flipRef.current = now;
    const list = listRef.current;
    if (!was.size || !list || reduceMotion()) return;
    // Only rows that start or end near the visible part animate.
    const top = list.scrollTop - 120;
    const bottom = list.scrollTop + list.clientHeight + 120;
    for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
      const to = now.get(el.dataset.flip!)!;
      const from = was.get(el.dataset.flip!);
      // A block with sub-sessions is tall, so test its whole span, not just its top.
      const near = (y: number) => y + el.offsetHeight > top && y < bottom;
      if (!near(to) && (from === undefined || !near(from))) continue;
      const dy = from === undefined ? null : from - to;
      if (dy === null) el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
      else if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 280, easing: EASE });
    }
  }, [layout]);

  // Recent takes the rows that fit under everything else; the content and the list's own height both trigger a recount.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      // A last callback can land after unmount, when the refs are already gone.
      const list = listRef.current;
      if (!list || list.hasAttribute('data-find')) return;
      // Rows that grew or shrank (a reply line came or went) move the FLIP baseline.
      flipRef.current = measure(innerRef.current!);
      const rows = recentRef.current?.children;
      const row = (rows?.[0] as HTMLElement | undefined)?.offsetHeight ?? 32;
      const n = (rows?.length ?? 0) + Math.floor((list.clientHeight - innerRef.current!.offsetHeight) / (row + 2));
      setFill(Math.min(PAST_CAP, Math.max(PAST_MIN, n)));
    });
    ro.observe(listRef.current!);
    ro.observe(innerRef.current!);
    return () => ro.disconnect();
  }, []);

  // Search: names of open and closed sessions in every folder, then conversation text from the server's index.
  // While the first index build runs, each answer asks again a bit later, like the palette.
  const building = found?.indexing ? found : null;
  useEffect(() => {
    if (q.length < 2) return;
    const t = setTimeout(() => send({ type: 'search', query: q }), building ? 2000 : 180);
    return () => clearTimeout(t);
  }, [q, building]);
  const tokens = fold(q).split(/\s+/).filter(Boolean);
  const has = (...xs: (string | null)[]) => {
    const f = fold(xs.join(' '));
    return tokens.every((t) => f.includes(t));
  };
  const findOpen = q ? roster.filter((r) => has(r.name, r.branch, baseName(r.cwd), baseName(folderOf.get(r.id) ?? r.cwd))) : [];
  const findPast = q ? allPast.filter((x) => !x.archived && !open.has(x.id) && has(x.name, x.branch, baseName(x.cwd))).slice(0, FIND_PAST) : [];
  const named = new Set([...findOpen, ...findPast].map((x) => x.id));
  const hits = q.length >= 2 && found ? found.hits.filter((h) => !h.archived && !named.has(h.id)) : [];
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery('');
      else e.currentTarget.blur();
    } else if (e.key === 'Enter') {
      listRef.current!.querySelector<HTMLElement>('.dp-main')?.click();
    }
  };

  return (
    <>
      <label className="dp-find">
        <FindIcon />
        <input
          ref={findRef} type="search" value={query} placeholder="Search sessions" aria-label="Search all sessions" spellCheck={false} autoComplete="off"
          onChange={(e) => setQuery(e.target.value)} onKeyDown={onFindKey}
        />
        {query && (
          <button type="button" className="dp-fx" aria-label="Clear search" title="Clear (Esc)" onClick={() => { setQuery(''); findRef.current!.focus(); }}>
            <XIcon />
          </button>
        )}
      </label>
      <div className="dp-list" ref={listRef} data-find={q ? '' : undefined}>
        <div className="dp-in" ref={innerRef}>
          {q ? (
            <>
              {findOpen.length > 0 && <div className="dp-sec">Open</div>}
              {findOpen.map((s) => <Live key={s.id} {...liveProps} id={s.id} index={indices.get(s.id)!} brief n={num.get(s.id)} curPattern={s.id === p.current ? p.curPattern : undefined} />)}
              {findPast.length > 0 && <div className="dp-sec">Closed</div>}
              {findPast.map((x) => <Past key={x.id} x={x} p={p} place />)}
              {hits.length > 0 && <div className="dp-sec">In conversations</div>}
              {hits.map((h) => {
                const live = open.get(h.id);
                return live ? <Live key={h.id} {...liveProps} id={h.id} index={indices.get(h.id)!} brief n={num.get(h.id)} curPattern={h.id === p.current ? p.curPattern : undefined} /> : <Past key={h.id} x={h} p={p} place snip={h.snippet} />;
              })}
              {!findOpen.length && !findPast.length && !hits.length && (
                <p className="dp-empty" role="status">
                  {q.length >= 2 && (!found || found.indexing) ? (found ? 'Indexing past conversations…' : 'Searching…') : 'No sessions match.'}
                </p>
              )}
            </>
          ) : (
            <>
              {p.folder && !here && <p className="dp-empty">No open sessions in this folder.</p>}
              {!p.folder && !folders.length && <p className="dp-empty">No open sessions.</p>}
              {orderedFolders.map((f, i) => (
                <Fragment key={f.cwd}>
                  {p.folder && f !== here && i === Number(!!here) && <div className="dp-sec" data-flip="sec">Other folders</div>}
                  <section className="dp-folder" aria-label={f.cwd}>
                    {/* The header chip already names the current folder; the others open and close in place. */}
                    {f !== here && (
                      <div className="dp-folder-head" data-flip={`h:${f.cwd}`}>
                        <button
                          type="button" className="dp-folder-tog" title={f.cwd} aria-expanded={!collapsed.has(f.cwd)}
                          onClick={(e) => toggleFolder(f.cwd, e.currentTarget.parentElement!.nextElementSibling)}
                        >
                          <FolderIcon /><span className="dp-folder-name" dir="auto">{baseName(f.cwd)}</span>
                          <span className={`dp-folder-count${f.busy ? ' busy' : ''}`} aria-label={`${f.count} open sessions`}>{f.count}</span>
                          <Chev />
                        </button>
                        <button
                          type="button" className="dp-folder-new" aria-label={`New session in ${baseName(f.cwd)}`} title="New session in this folder"
                          aria-busy={p.pending === newKey(f.cwd) || undefined} onClick={() => openNew(f.cwd)}
                        >
                          {p.pending === newKey(f.cwd) ? <span className="g spin"></span> : <PlusIcon />}
                        </button>
                      </div>
                    )}
                    {(f === here || !collapsed.has(f.cwd)) && <div className="dp-folder-rows">
                      {f.entries.map(({ row, children, group, mainName }) => (
                        <div key={row.id} className="dp-grp" data-flip={`g:${row.id}`}>
                          {row.index >= 0 ? (
                            <Live {...liveProps} id={row.id} index={row.index} member={row.member} grouped mainName={mainName} brief={!!p.folder && f !== here}
                              onSub={mainName ? undefined : setCreating} n={num.get(row.id)} curPattern={row.id === p.current ? p.curPattern : undefined} />
                          ) : <Closed m={row.member!} p={p} grouped />}
                          {group && (
                            <>
                              {children.length > 0 && <div className="dp-tree" role="group" aria-label={`Sub-sessions of ${group.main.name}`}>
                                {children.map((c) => c.index >= 0 ? (
                                  <Live key={c.id} {...liveProps} id={c.id} index={c.index} member={c.member} grouped brief={!!p.folder && f !== here} n={num.get(c.id)} curPattern={c.id === p.current ? p.curPattern : undefined} />
                                ) : <Closed key={c.id} m={c.member!} p={p} grouped />)}
                              </div>}
                              {group.cleanupNotice && group.cleanupAt && (
                                <p className="dp-note">
                                  Group cleanup {new Date(group.cleanupAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                  <button type="button" onClick={() => send({ type: 'group-keep', groupId: group.id })}>Keep</button>
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>}
                  </section>
                </Fragment>
              ))}
              {p.term.length > 0 && <div className="dp-sec">In a terminal</div>}
              {p.term.map((t) => {
                const name = terminalName(t, allPast);
                return (
                  <div key={t.id} className="dp-row past" data-k={`t:${t.id}`}>
                    <button
                      type="button" className="dp-main" title={`${name} · click to resume it here`} aria-busy={p.pending === resumeKey(t.id) || undefined}
                      onClick={() => resumeSession(t.id)}
                    >
                      <span className="dp-ic">{p.pending === resumeKey(t.id) ? <span className="g spin"></span> : <TermIcon tone={termTone(t)} />}</span>
                      <span className="dp-l1">
                        <span className="dp-nm" dir="auto">{name}</span>
                        <span className={`dp-st${termTone(t)}`}>{termState(t)}</span>
                      </span>
                    </button>
                  </div>
                );
              })}
              {past.length > 0 && <div className="dp-sec">Recent</div>}
              {past.length > 0 && (
                <div className="dp-grp" ref={recentRef}>
                  {past.map((x) => <Past key={x.id} x={x} p={p} />)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {creating && (
        <Suspense fallback={null}>
          <SubsessionDialog key={creating.id} source={creating} onClose={() => setCreating(null)} />
        </Suspense>
      )}
    </>
  );
}
