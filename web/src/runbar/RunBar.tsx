import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { currentSummary, useStore } from '../store.ts';
import { Chev, baseName } from '../bits.tsx';
import { Led } from '../led.tsx';
import { ChunkGuard } from '../Stale.tsx';
import { useLayoutVars } from '../layoutVars.ts';
import { summarize, useRun } from './state.ts';

const loadCard = () => import('./RunCard.tsx');
const RunCard = lazy(() => loadCard().then((m) => ({ default: m.RunCard })));

export function RunDot({ tone }: { tone: 'idle' | 'on' | 'busy' | 'bad' }) {
  if (tone === 'busy') return <span className="rb-led"><Led size="sm" pattern="run" /></span>;
  if (tone === 'bad') return <span className="rb-led"><Led size="sm" pattern="fault" still /></span>;
  return <i className={`rb-dot${tone === 'on' ? ' on' : ''}`} aria-hidden="true" />;
}

// Project commands: a pill beside the composer that opens the folder's card upward. Esc and an outside click close it.
export function RunBar() {
  const cwd = useStore((s) => currentSummary(s)?.cwd);
  const folder = useRun((s) => s.folder);
  const pop = useRef<HTMLDivElement>(null);
  // Under 720px both sit above the composer through --ch.
  const pillEl = useLayoutVars();
  const popEl = useLayoutVars(pop);
  const [open, setOpen] = useState(false);
  const [ever, setEver] = useState(false);

  useEffect(() => {
    const p = pop.current;
    if (!p) return;
    const toggled = (e: Event) => {
      const on = (e as ToggleEvent).newState === 'open';
      setOpen(on);
      if (on) setEver(true);
    };
    p.addEventListener('toggle', toggled);
    return () => p.removeEventListener('toggle', toggled);
  }, [cwd]);

  if (!cwd) return null;
  const { tone, text } = summarize(folder?.folder === cwd ? folder : null);
  const name = baseName(cwd);
  return (
    <>
      <button
        ref={pillEl} type="button" className="rb-pill" popoverTarget="rbCard" aria-expanded={open} aria-controls="rbCard"
        aria-label={`Project commands for ${name}${text ? `: ${text}` : ''}`} title={text ? `${name} · ${text}` : name} onPointerEnter={() => void loadCard()}
      >
        <RunDot tone={tone} />
        <span className="rb-lbl">
          <b>{name}</b>
          <small role="status">{text}</small>
        </span>
        <Chev />
      </button>
      <div className="pop rb-card" id="rbCard" popover="auto" ref={popEl} aria-label={`Project commands for ${name}`}>
        {ever && <ChunkGuard><Suspense fallback={null}><RunCard open={open} /></Suspense></ChunkGuard>}
      </div>
    </>
  );
}
