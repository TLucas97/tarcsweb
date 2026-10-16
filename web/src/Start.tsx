import { useEffect, useState, type KeyboardEvent } from 'react';
import { setPalette, useStore } from './store.ts';
import { openSession, send } from './socket.ts';
import { CodexTag, GLYPH, Glyph, ago, baseName, tilde } from './bits.tsx';
import { HistIcon } from './SessionMenu.tsx';
import { Robot } from './robot.tsx';
import { HeroRobot } from './robotHero.tsx';
import type { ClientMessage, SessionSummary } from '../../server/protocol.ts';

const OPEN_MAX = 6;
const RECENT_MAX = 5;
const FOLDERS_MAX = 3;

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" /></svg>
);
const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
);
const ListIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M2 3.5h9M2 6.5h9M2 9.5h6" /></svg>
);

type Kind = 'need' | 'finished' | 'working' | 'agents' | 'idle';
const kindOf = (r: SessionSummary): Kind =>
  r.needsYou || r.state === 'waiting' ? 'need' : r.state === 'done' ? 'finished' : r.state === 'working' ? 'working' : r.background ? 'agents' : 'idle';
// What needs a decision comes first, then fresh results, then running work.
const RANK: Record<Kind, number> = { need: 0, finished: 1, working: 2, agents: 3, idle: 4 };

// "12m ago", "3h ago", "yesterday", "Oct 8".
function since(ms: number) {
  const a = ago(ms);
  return a === 'now' ? 'just now' : /\d[mh]$/.test(a) ? `${a} ago` : a;
}

function stateLabel(r: SessionSummary, k: Kind) {
  if (k === 'need') return 'Needs you';
  if (k === 'working') return 'Working';
  if (k === 'agents') return 'Agents running';
  if (k === 'finished') return `Finished ${since(r.doneAt || r.lastActive)}`;
  return `Idle · ${since(r.doneAt || r.lastActive)}`;
}

// Idle labels say "12m ago", so they refresh once a minute while the page is on screen.
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => !document.hidden && setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}

function Status({ open, connected }: { open: SessionSummary[]; connected: boolean }) {
  if (!connected && !open.length) return <p className="st-status">Connecting to the server…</p>;
  if (!open.length) return <p className="st-status">Nothing is running. Start a session or pick up a recent one.</p>;
  const n: Record<Kind, number> = { need: 0, finished: 0, working: 0, agents: 0, idle: 0 };
  for (const r of open) n[kindOf(r)]++;
  return (
    <p className="st-status">
      {n.need > 0 && <span className="st-seg need"><Glyph state="waiting" />{n.need} need{n.need === 1 ? 's' : ''} you</span>}
      {n.working > 0 && <span className="st-seg"><Robot size={GLYPH} state="calm" />{n.working} working</span>}
      {n.agents > 0 && <span className="st-seg"><Robot size={GLYPH} state="calm" />{n.agents} with agents running</span>}
      {n.finished > 0 && <span className="st-seg"><span className="g dot d"></span>{n.finished} finished</span>}
      {n.idle > 0 && <span className="st-seg"><span className="g dot"></span>{n.idle} idle</span>}
    </p>
  );
}

// Shown when no session is open: what runs now, where to start, and what to pick up again.
export function Start() {
  const roster = useStore((s) => s.roster);
  const past = useStore((s) => s.past);
  const home = useStore((s) => s.home);
  const connected = useStore((s) => s.connected);
  // The pressed action, so a second click cannot start a second session before the first one opens.
  const [busy, setBusy] = useState<string | null>(null);
  useMinuteTick();

  // Looking at Start is intent: a stale Codex list may refresh.
  useEffect(() => {
    if (connected) send({ type: 'list-past', fresh: true });
  }, [connected]);

  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(null), 6000);
    return () => clearTimeout(t);
  }, [busy]);

  const open = [...roster].sort((a, b) => RANK[kindOf(a)] - RANK[kindOf(b)] || b.lastActive - a.lastActive);
  const openIds = new Set(roster.map((r) => r.id));
  const recent = past.filter((p) => !p.archived && !openIds.has(p.id)).sort((a, b) => b.lastModified - a.lastModified);

  const seen = new Map<string, number>();
  for (const r of roster) seen.set(r.cwd, Math.max(seen.get(r.cwd) ?? 0, r.lastActive));
  for (const p of past) if (!p.archived) seen.set(p.cwd, Math.max(seen.get(p.cwd) ?? 0, p.lastModified));
  const folders = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, FOLDERS_MAX).map(([cwd]) => cwd);

  const where = (cwd: string) => (home && cwd === home ? '~' : baseName(cwd));

  const run = (key: string, msg: ClientMessage) => {
    if (busy) return;
    if (!send(msg)) return useStore.setState({ notice: 'Not connected', noticeInfo: false });
    setBusy(key);
  };

  // Up and Down walk every button in reading order; Tab still works as usual.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
  };

  return (
    <section className="start" aria-label="Start" aria-busy={!!busy} onKeyDown={onKeyDown}>
      <header className="st-head st-in">
        <HeroRobot />
        <div className="st-hd">
          <h1>No session open</h1>
          <Status open={open} connected={connected} />
        </div>
      </header>

      {open.length > 0 && (
        <div className="st-sec st-in">
          <div className="st-lbl"><h2>Open now</h2></div>
          <div className="st-list open">
            {open.slice(0, OPEN_MAX).map((r) => {
              const k = kindOf(r);
              return (
                <button key={r.id} type="button" className="st-row" data-k={k} title={`${r.name}\n${tilde(r.cwd, home)}`} onClick={() => openSession(r.id)}>
                  <span className="st-ic"><Glyph state={r.state} background={r.background} /></span>
                  <span className="st-n">{r.provider === 'codex' && <CodexTag />}{r.name}</span>
                  <span className="st-meta">
                    <span className="st-f">{where(r.cwd)}</span>
                    <span className="st-st">{stateLabel(r, k)}</span>
                  </span>
                </button>
              );
            })}
            {open.length > OPEN_MAX && (
              <button type="button" className="st-row st-more" onClick={() => setPalette('switch')}>
                <span className="st-ic"><ListIcon /></span>
                <span className="st-n">{open.length - OPEN_MAX} more open…</span>
              </button>
            )}
            <i className="hl"></i>
          </div>
        </div>
      )}

      <div className="st-sec st-in">
        <div className="st-lbl"><h2 id="st-new">New session in</h2></div>
        <div className="st-chips" role="group" aria-labelledby="st-new">
          {folders.map((cwd) => (
            <button
              key={cwd} type="button" className="st-chip" title={`New session in ${tilde(cwd, home)}`} disabled={!!busy && busy !== `new:${cwd}`}
              onClick={() => run(`new:${cwd}`, { type: 'open', cwd, ...useStore.getState().defaults })}
            >
              {busy === `new:${cwd}` ? <span className="g spin"></span> : <FolderIcon />}
              <span className="st-cn">{where(cwd)}</span>
            </button>
          ))}
          <button type="button" className="st-chip other" disabled={!!busy} onClick={() => setPalette('folder')}>
            <PlusIcon />
            <span className="st-cn">{folders.length ? 'Other folder…' : 'Choose a folder…'}</span>
            <kbd>alt N</kbd>
          </button>
        </div>
      </div>

      {recent.length > 0 && (
        <div className="st-sec st-in">
          <div className="st-lbl">
            <h2>Pick up again</h2>
            <button type="button" className="st-all" onClick={() => setPalette('switch')}>
              All sessions<kbd>ctrl K</kbd>
            </button>
          </div>
          <div className="st-list past">
            {recent.slice(0, RECENT_MAX).map((p) => (
              <button
                key={p.id} type="button" className="st-row" title={`${p.name}\n${tilde(p.cwd, home)}`} disabled={!!busy && busy !== `resume:${p.id}`}
                onClick={() => run(`resume:${p.id}`, { type: 'resume', id: p.id })}
              >
                <span className="st-ic">{busy === `resume:${p.id}` ? <span className="g spin"></span> : <HistIcon />}</span>
                <span className="st-n">{p.provider === 'codex' && <CodexTag />}{p.name}</span>
                <span className="st-meta">
                  <span className="st-f">{where(p.cwd)}</span>
                  <span className="st-st">{since(p.lastModified)}</span>
                </span>
              </button>
            ))}
            <i className="hl"></i>
          </div>
        </div>
      )}
    </section>
  );
}
