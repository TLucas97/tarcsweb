import { Fragment, Suspense, lazy, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { sessionOrder, useStore } from './store.ts';
import { send } from './socket.ts';
import { resumeKey, resumeSession } from './actions.ts';
import { BranchIcon, CodexTag, RenameInput, XIcon, ago, baseName } from './bits.tsx';
import { HistIcon } from './SessionMenu.tsx';
import { TermIcon, needsYou, subLabel, termState, termTone } from './DockFolders.tsx';
import { ownsCtrlKeys } from './embed.ts';
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
  // The folder's open tabs in dock order, its closed sessions and its terminal sessions.
  tabs: SessionSummary[];
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

type Where = { cwd: string; branch: string | null; worktree: boolean };

// Folder and branch; a worktree of its own shows its branch and the mark instead, its folder is only that checkout.
function Place({ w, cost }: { w: Where; cost?: string | null }) {
  return (
    <span className="dp-l2">
      {!w.worktree && <span className="dp-f">{baseName(w.cwd)}</span>}
      {!w.worktree && w.branch && <span className="dp-sep" aria-hidden="true">·</span>}
      {w.branch && (
        <>
          <BranchIcon />
          <span className="dp-br">{w.branch}</span>
        </>
      )}
      {w.worktree && <span className="dp-wt" title={baseName(w.cwd)}>worktree</span>}
      {cost && <span className="dp-cost" title="Cost reported by the provider">{cost}</span>}
    </span>
  );
}

// brief: name, state and place only, for sessions listed away from their folder's tree. n: its Ctrl/Alt+digit number.
type RowProps = PanelProps & { s: SessionSummary; member?: GroupMember; onSub?: () => void; brief?: boolean; n?: number };

function Live({ s, member, onSub, brief, n, ...p }: RowProps) {
  const cur = s.id === p.current;
  const need = needsYou(s);
  const tone = need ? ' needs' : s.state === 'done' ? ' done' : '';
  const state = subLabel(s);
  // While a turn runs, what it is doing; otherwise the end of its last reply.
  const doing = s.state === 'working' && !need ? s.activity : '';
  const reply = doing || oneLine(s.lastReply);
  const wt = member?.worktree;
  const where = { cwd: s.cwd, branch: wt?.branch ?? s.branch, worktree: !!wt || !!s.worktree };
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
      <Place w={where} cost={money(s.cost)} />
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
          <button type="button" className="dp-add" aria-label={`New sub-session of ${s.name}`} title="New sub-session" onClick={onSub}><PlusIcon /></button>
        )}
        <button
          type="button" className="dp-x" aria-label={armed ? `Stop and close ${s.name}` : `Close ${s.name}`} title={armed ? 'Click again to stop it and close' : 'Close (alt W)'}
          onClick={() => p.onClose(s.id)}
        ><XIcon /></button>
      </span>
      {armed && <span className="dp-arm" role="status">Stop and close? Click again</span>}
    </div>
  );
}

// A group member whose tab is closed; it reopens from its saved conversation when there is one.
// Right-click opens the same menu as a Recent row, when there is a saved conversation.
function Closed({ m, p }: { m: GroupMember; p: PanelProps }) {
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
        <Place w={{ cwd: m.cwd, branch: m.worktree?.branch ?? null, worktree: !!m.worktree }} />
      </button>
    </div>
  );
}

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

type Entry = { s: SessionSummary | undefined; g: GroupState | undefined };

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
  const open = new Map(roster.map((r) => [r.id, r]));
  const groupOf = new Map<string, GroupState>();
  for (const g of groups) for (const m of [g.main, ...g.children]) groupOf.set(m.id, g);
  // A group shows once, where its first member sits in the dock order, headed by its main session even if that is closed
  // or lives in another folder; sub-sessions only appear under it.
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const t of p.tabs) {
    const g = groupOf.get(t.id);
    if (!g) {
      entries.push({ s: t, g });
      continue;
    }
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    entries.push({ s: open.get(g.main.id), g });
  }
  // Same numbers as Ctrl/Alt+digit; the order itself is arranged from the header's Arrange menu.
  const num = new Map(sessionOrder({ roster, dockOrder }, pins).map((id, i) => [id, i + 1]));
  const byNum = (a: string, b: string) => (num.get(a) ?? Infinity) - (num.get(b) ?? Infinity);
  const treeHistory = new Set(entries.flatMap(({ g }) => g ? [g.main, ...g.children].flatMap((m) => m.savedId ? [m.savedId] : []) : []));
  const past = p.past.filter((s) => !treeHistory.has(s.id)).slice(0, fill);
  // Open sessions of every other folder, right under this folder's open ones; closed ones (Recent) come last.
  const listed = new Set([...p.tabs.map((t) => t.id), ...entries.flatMap(({ g }) => (g ? [g.main.id, ...g.children.map((c) => c.id)] : []))]);
  const others = roster.filter((r) => !listed.has(r.id)).sort((a, b) => byNum(a.id, b.id));

  // Recent takes the rows that fit under everything else; the content and the list's own height both trigger a recount.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      // A last callback can land after unmount, when the refs are already gone.
      const list = listRef.current;
      if (!list || list.hasAttribute('data-find')) return;
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
  const findOpen = q ? roster.filter((r) => has(r.name, r.branch, baseName(r.cwd))) : [];
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
              {findOpen.map((s) => <Live key={s.id} {...p} s={s} brief n={num.get(s.id)} />)}
              {findPast.length > 0 && <div className="dp-sec">Closed</div>}
              {findPast.map((x) => <Past key={x.id} x={x} p={p} place />)}
              {hits.length > 0 && <div className="dp-sec">In conversations</div>}
              {hits.map((h) => {
                const live = open.get(h.id);
                return live ? <Live key={h.id} {...p} s={live} brief n={num.get(h.id)} /> : <Past key={h.id} x={h} p={p} place snip={h.snippet} />;
              })}
              {!findOpen.length && !findPast.length && !hits.length && (
                <p className="dp-empty" role="status">
                  {q.length >= 2 && (!found || found.indexing) ? (found ? 'Indexing past conversations…' : 'Searching…') : 'No sessions match.'}
                </p>
              )}
            </>
          ) : (
            <>
              {entries.length === 0 && <p className="dp-empty">No open sessions in this folder.</p>}
              {entries.map(({ s, g }) => {
                const main = s ? (
                  <Live {...p} s={s} member={g?.main} onSub={g ? undefined : () => setCreating(s)} n={num.get(s.id)} />
                ) : (
                  <Closed m={g!.main} p={p} />
                );
                if (!g) return <div key={s!.id} className="dp-grp">{main}</div>;
                const kids = g.children.length;
                return (
                  <div key={g.id} className="dp-grp">
                    {main}
                    <div className="dp-tree" role="group" aria-label={`Sub-sessions of ${g.main.name}`}>
                      {/* Open sub-sessions first, in number order; closed ones below them. */}
                      {g.children.toSorted((a, b) => byNum(a.id, b.id)).map((c) => {
                        const live = open.get(c.id);
                        return live ? <Live key={c.id} {...p} s={live} member={c} n={num.get(c.id)} /> : <Closed key={c.id} m={c} p={p} />;
                      })}
                      {s && (
                        <button type="button" className="dp-addsub" onClick={() => setCreating(s)}>
                          <PlusIcon />{kids ? 'Sub-session' : 'New sub-session'}
                        </button>
                      )}
                    </div>
                    {g.cleanupNotice && g.cleanupAt && (
                      <p className="dp-note">
                        Group cleanup {new Date(g.cleanupAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        <button type="button" onClick={() => send({ type: 'group-keep', groupId: g.id })}>Keep</button>
                      </p>
                    )}
                  </div>
                );
              })}
              {others.length > 0 && <div className="dp-sec">Other folders</div>}
              {others.map((s) => <Live key={s.id} {...p} s={s} brief n={num.get(s.id)} />)}
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
