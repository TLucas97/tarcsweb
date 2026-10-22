import type { ChangeCard } from '../../server/protocol.ts';
import { useStore } from './store.ts';
import { openDiff } from './Focus.tsx';
import { Led } from './led.tsx';

export function Card({ c, item, sessionId, last }: { c: ChangeCard; item: string; sessionId: string; last: boolean }) {
  const state = useStore((s) => s.panels[sessionId]?.agents.find((a) => a.id === c.owner)?.state);
  // Only the open turn's cards can still grow; later edits go to the next turn's cards.
  const live = last && (state === 'running' || state === 'waiting');
  const n = c.files.length;
  const title = c.kind === 'revert' ? 'Open the reverts; each one can be put back from there'
    : c.kind === 'shell' ? 'Files changed by commands or other programs, not by a file tool' : 'Open the full diff';
  return (
    <button
      type="button" className={`dv-card${c.main ? ' main' : ''}${c.kind ? ` ${c.kind}` : ''}`} title={title}
      onClick={(e) => openDiff({ sessionId, item, card: c.id }, c.name, e.currentTarget)}
    >
      <svg className="dv-ic" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 1.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" /><path d="M8 1.5V5h3.5M5 8.5h4M7 6.5v4" />
      </svg>
      <span className="dv-nm">{c.name}</span>
      <span className="dv-ct">{n} file{n === 1 ? '' : 's'}</span>
      <span className="mono dv-add">+{c.add}</span>
      <span className="mono dv-rm">−{c.rm}</span>
      {live && <span className="dv-led" role="img" aria-label="Still working"><Led size="sm" pattern="calm" /></span>}
    </button>
  );
}

// One card per agent that changed files in this turn; a click opens the full diff.
export function ChangeStrip({ id, cards }: { id: string; cards: ChangeCard[] }) {
  const sessionId = useStore((s) => s.current);
  const last = useStore((s) => s.order[s.order.length - 1] === id);
  const shown = cards.filter((c) => c.files.length);
  if (!sessionId || !shown.length) return null;
  return (
    <div className="dv-strip" data-id={id}>
      {shown.map((c) => <Card key={c.id} c={c} item={id} sessionId={sessionId} last={last} />)}
    </div>
  );
}
