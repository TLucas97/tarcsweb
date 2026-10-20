import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { currentSummary, useStore } from '../store.ts';
import { putCommand } from '../SendToChat.tsx';
import { BranchIcon } from '../bits.tsx';

const QaIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.8 2.4H3.6a1 1 0 0 0-1 1v8.2a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V3.4a1 1 0 0 0-1-1H9.2M5.2 1.4h3.6v2H5.2zM5 8.2l1.4 1.4 2.7-2.8" />
  </svg>
);
const BookIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3.2C5 2.4 3.6 2.1 1.6 2.2v7.2c2-.1 3.4.2 4.4 1 1-.8 2.4-1.1 4.4-1V2.2c-2-.1-3.4.2-4.4 1zM6 3.2v7.2" />
  </svg>
);

// The skills that ship with the app; a pick fills the composer and the user sends it.
const ITEMS = [
  { cmd: 'tarcsweb:learn-app', name: 'Learn this app', desc: 'Learns how to run and test this project', Icon: BookIcon },
  { cmd: 'tarcsweb:validate-pr', name: 'Validate PR', desc: 'Checks out a PR and tests it here', Icon: BranchIcon },
] as const;

const POP = 'brwQaPop';

// A small menu at the end of the address bar; opens below its button, right-aligned to it.
export function QaMenu({ onPick }: { onPick: () => void }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const why = useStore((s) => (!s.current ? 'Open a Claude conversation first' : currentSummary(s)?.caps?.slash === false ? "Codex tabs don't load these skills" : null));

  useEffect(() => {
    const pop = popRef.current!;
    const onToggle = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next) return;
      const r = btnRef.current!.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.right = `${Math.max(12, Math.round(innerWidth - r.right))}px`;
    };
    pop.addEventListener('beforetoggle', onToggle);
    return () => pop.removeEventListener('beforetoggle', onToggle);
  }, []);

  // Hidden first, so the popover's focus return lands before the composer takes focus.
  const pick = (cmd: string) => {
    popRef.current!.hidePopover();
    onPick();
    if (!putCommand(cmd)) useStore.setState({ notice: 'No composer is open to put the command in', noticeInfo: false });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...popRef.current!.querySelectorAll<HTMLElement>('.mi:not(:disabled)')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  return (
    <>
      <button
        type="button" ref={btnRef} className={`brw-nav brw-qa${open ? ' open' : ''}`} popoverTarget={POP}
        aria-haspopup="menu" aria-expanded={open} aria-label="Test this app with Claude" title="Test this app with Claude"
      >
        <QaIcon />
      </button>
      <div className="pop ctx brw-qa-pop" id={POP} popover="auto" ref={popRef} role="menu" aria-label="Test this app" onKeyDown={onKeyDown}>
        <div className="pg"><span>Fills in the composer</span></div>
        {ITEMS.map(({ cmd, name, desc, Icon }) => (
          <button key={cmd} type="button" className="mi" role="menuitem" disabled={!!why} title={why ?? `/${cmd}`} onClick={() => pick(cmd)}>
            <span className="nm2"><Icon />{name}</span><small>{why ?? desc}</small>
          </button>
        ))}
      </div>
    </>
  );
}
