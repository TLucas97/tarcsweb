import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { create } from 'zustand';
import { branchFrom } from './actions.ts';
import { BranchIcon } from './bits.tsx';
import { currentSummary, useStore } from './store.ts';

// One menu for the whole conversation; rows only ask it to open.
type Target = { sessionId: string; item: string; left: number; top: number; bottom: number; user: boolean };
const useBranchMenu = create<{ target: Target | null }>(() => ({ target: null }));

const FolderIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M1.2 3.2c0-.6.4-1 1-1h2.4l1 1.2h4.2c.6 0 1 .4 1 1v4.6c0 .6-.4 1-1 1H2.2c-.6 0-1-.4-1-1z" /></svg>
);

// Outside a git repo there is nothing to choose, so the branch starts at once.
function openBranch(item: string, el: HTMLElement, user: boolean) {
  const s = useStore.getState();
  const sum = currentSummary(s);
  if (!s.current || sum?.caps?.branch !== true) return;
  if (!sum.branch) return branchFrom(s.current, item, false);
  const r = el.getBoundingClientRect();
  useBranchMenu.setState({ target: { sessionId: s.current, item, left: r.left, top: r.top, bottom: r.bottom, user } });
}

// Codex tabs hide it with an attribute on the conversation column, so rows subscribe to nothing for it.
export function BranchBtn({ id, user = false }: { id: string; user?: boolean }) {
  const title = user ? 'Branch from here: a new tab with this turn and everything before it' : 'Branch from here: a new tab with the conversation up to this reply';
  return (
    <button type="button" className="cpb brb" aria-label="Branch from here" title={title} onClick={(e) => openBranch(id, e.currentTarget, user)}>
      <BranchIcon />
      {!user && <span>Branch</span>}
    </button>
  );
}

const MENU_H = 130;

export function BranchMenu() {
  const target = useBranchMenu((s) => s.target);
  const popRef = useRef<HTMLDivElement>(null);
  const close = () => useBranchMenu.setState({ target: null });

  useLayoutEffect(() => {
    const pop = popRef.current!;
    if (!target) {
      if (pop.matches(':popover-open')) pop.hidePopover();
      return;
    }
    pop.style.left = Math.max(12, Math.min(target.left, innerWidth - 284)) + 'px';
    // Near the bottom it opens upward, so it never runs off the window.
    const up = target.bottom + MENU_H > innerHeight;
    pop.style.top = up ? 'auto' : target.bottom + 4 + 'px';
    pop.style.bottom = up ? innerHeight - target.top + 4 + 'px' : 'auto';
    if (!pop.matches(':popover-open')) pop.showPopover();
    pop.querySelector<HTMLElement>('.mi')?.focus({ preventScroll: true });
  }, [target]);

  useEffect(() => {
    const pop = popRef.current!;
    const onToggle = (e: Event) => (e as ToggleEvent).newState === 'closed' && close();
    pop.addEventListener('toggle', onToggle);
    return () => pop.removeEventListener('toggle', onToggle);
  }, []);

  const pick = (worktree: boolean) => () => {
    popRef.current!.hidePopover();
    if (target) branchFrom(target.sessionId, target.item, worktree);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...popRef.current!.querySelectorAll<HTMLElement>('.mi')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  const upTo = target?.user ? 'through this turn' : 'up to this reply';

  return (
    <div className="pop mpop ctx" popover="auto" ref={popRef} role="menu" aria-label="Branch from here" onKeyDown={onKeyDown}>
      <button className="mi" role="menuitem" onClick={pick(false)}>
        <span className="nm2"><FolderIcon />Branch here</span>
        <small>New tab in this folder, with the conversation {upTo}</small>
      </button>
      <button className="mi" role="menuitem" onClick={pick(true)}>
        <span className="nm2"><BranchIcon />Branch in a new worktree</span>
        <small>New git worktree and branch at HEAD. Uncommitted changes are not copied</small>
      </button>
    </div>
  );
}
