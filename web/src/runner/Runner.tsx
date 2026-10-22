import { useEffect, useRef, useState } from 'react';
import { XIcon, useEscape } from '../bits.tsx';
import { needsYou } from '../DockFolders.tsx';
import { useStore } from '../store.ts';
import { Game, pad, type Over } from './game.ts';
import { setRunner } from './open.ts';

// The session on screen and anyone waiting on you; the game never pauses for it.
function Status() {
  const working = useStore((s) => s.status === 'working');
  const step = useStore((s) => (s.current ? s.maps[s.current]?.now : undefined));
  // '' for the session on screen, a name for another one, null when nobody waits.
  const call = useStore((s) => {
    if (s.asks > 0) return '';
    const r = s.roster.find(needsYou);
    return r ? (r.id === s.current ? '' : r.name) : null;
  });
  const text = call !== null ? (call ? `${call} needs you` : 'Needs you') : working ? (step && !/^(Idle|Waiting for)/.test(step) ? step : 'Thinking') : 'Idle';
  return (
    <div className={`rn-st${call !== null ? ' needs' : working ? ' on' : ''}`} title={text}>
      <i aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

// Full screen like watch mode: the app under it stops painting, Esc or the close button leaves.
export default function Runner() {
  const root = useRef<HTMLDivElement>(null);
  const game = useRef<Game | null>(null);
  const [over, setOver] = useState<Over | null>(null);

  useEffect(() => {
    const el = root.current!;
    const g = new Game(el);
    g.onOver = setOver;
    g.onStart = () => setOver(null);
    game.current = g;
    document.body.dataset.runner = '';
    // The stage takes focus, not a button, so Space jumps instead of pressing one.
    el.focus({ preventScroll: true });
    return () => {
      delete document.body.dataset.runner;
      g.dispose();
      game.current = null;
    };
  }, []);

  useEscape(true, () => setRunner(false));

  return (
    <div ref={root} className="rn" role="dialog" aria-modal="true" aria-label="Runner game" tabIndex={-1}>
      <canvas className="rn-world" aria-hidden="true" />
      <div className="rn-bot" aria-hidden="true" />
      <header className="rn-hud">
        <Status />
        <div className="rn-sc mono" aria-hidden="true">
          <span className="rn-hi" />
          <span className="rn-now" />
        </div>
        <button type="button" className="rn-x" title="Leave (Esc)" aria-label="Leave the game" onClick={() => setRunner(false)}>
          <XIcon />
        </button>
      </header>
      {over && (
        <div className="rn-over">
          <b>{over.rec ? 'New record!' : 'Crashed'}</b>
          <span className="rn-os mono">
            {pad(over.score)} · <span className={over.rec ? 'rec' : undefined}>record {pad(over.best)}</span>
          </span>
          <button type="button" className="rn-go" onClick={() => game.current?.start()}>Again</button>
          <small>or Space · Esc leaves</small>
        </div>
      )}
      {/* The game shows it at each start and before the first stairs of a run. */}
      <p className="rn-hint" aria-hidden="true">Space, ↑ or click to jump · jump again in the air · hold it to glide</p>
    </div>
  );
}
