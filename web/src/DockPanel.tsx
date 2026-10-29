import { Suspense, lazy, useState, type MouseEvent } from 'react';
import { useStore } from './store.ts';
import { send } from './socket.ts';
import { resumeKey, resumeSession } from './actions.ts';
import { BranchIcon, CodexTag, RenameInput, XIcon, ago, baseName } from './bits.tsx';
import { HistIcon } from './SessionMenu.tsx';
import { TermIcon, needsYou, subLabel, termState, termTone } from './DockFolders.tsx';
import { SessionTile } from './sessionColor.tsx';
import { TabPhone } from './Remote.tsx';
import { terminalName } from './terminal.ts';
import type { LedPattern } from './led.tsx';
import type { GroupMember, GroupState, PastSession, SessionSummary, TerminalSession } from '../../server/protocol.ts';

const SubsessionDialog = lazy(() => import('./SubsessionDialog.tsx'));

// Closed sessions listed under the open tabs; All in the footer reaches the rest.
const PAST_MAX = 6;

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

type RowProps = PanelProps & { s: SessionSummary; member?: GroupMember; onSub?: () => void };

function Live({ s, member, onSub, ...p }: RowProps) {
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
  const body = (
    <>
      {tile}
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
      {reply && <span className={`dp-l3${doing ? ' doing' : ''}`} dir="auto" title={reply}>{reply}</span>}
    </>
  );
  return (
    <div className={`dp-row${cur ? ' cur' : ''}`} data-k={s.id} data-menu={p.menuId === s.id ? '' : undefined} data-arm={armed ? '' : undefined}>
      {p.editing === s.id ? (
        <div className="dp-main editing" aria-current={cur ? 'page' : undefined}>{body}</div>
      ) : (
        <button
          type="button" className="dp-main" aria-current={cur ? 'page' : undefined} title={s.name}
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
function Closed({ m, pending }: { m: GroupMember; pending: string | null }) {
  const id = m.savedId;
  const busy = !!id && pending === resumeKey(id);
  return (
    <div className="dp-row closed" data-k={m.id}>
      <button
        type="button" className="dp-main" aria-disabled={!id || undefined} aria-busy={busy || undefined}
        title={id ? `${m.name} · Closed, click to reopen` : `${m.name} · Closed, no saved conversation to reopen`} onClick={() => id && resumeSession(id)}
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

type Entry = { s: SessionSummary | undefined; g: GroupState | undefined };

export default function DockPanel(p: PanelProps) {
  const roster = useStore((s) => s.roster);
  const groups = useStore((s) => s.groups);
  const allPast = useStore((s) => s.past);
  const [creating, setCreating] = useState<SessionSummary | null>(null);
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
  const past = p.past.slice(0, PAST_MAX);

  return (
    <>
      <div className="dp-list">
        {entries.length === 0 && <p className="dp-empty">No open sessions in this folder.</p>}
        {entries.map(({ s, g }) => {
          const main = s ? (
            <Live {...p} s={s} member={g?.main} onSub={g ? undefined : () => setCreating(s)} />
          ) : (
            <Closed m={g!.main} pending={p.pending} />
          );
          if (!g) return <div key={s!.id} className="dp-grp">{main}</div>;
          const kids = g.children.length;
          return (
            <div key={g.id} className="dp-grp">
              {main}
              <div className="dp-tree" role="group" aria-label={`Sub-sessions of ${g.main.name}`}>
                {g.children.map((c) => {
                  const live = open.get(c.id);
                  return live ? <Live key={c.id} {...p} s={live} member={c} /> : <Closed key={c.id} m={c} pending={p.pending} />;
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
        {past.length > 0 && <div className="dp-sec">Recent</div>}
        {past.map((x) => (
          <div key={x.id} className="dp-row past" data-k={x.id} data-menu={p.menuId === x.id ? '' : undefined}>
            <button
              type="button" className="dp-main" title={x.name} aria-busy={p.pending === resumeKey(x.id) || undefined}
              onClick={() => resumeSession(x.id)} onContextMenu={(e) => p.onMenu(e, x.id, true)}
            >
              <span className="dp-ic">{p.pending === resumeKey(x.id) ? <span className="g spin"></span> : <HistIcon />}</span>
              <span className="dp-l1">
                <span className="dp-nm" dir="auto">{x.name}</span>
                {x.provider === 'codex' && <CodexTag />}
                <span className="dp-st">{ago(x.lastModified)}</span>
              </span>
            </button>
          </div>
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
      </div>
      {creating && (
        <Suspense fallback={null}>
          <SubsessionDialog key={creating.id} source={creating} onClose={() => setCreating(null)} />
        </Suspense>
      )}
    </>
  );
}
