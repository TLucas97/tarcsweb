import { useEffect, useId, useRef, useState } from 'react';
import type { QuitWork } from '../../server/protocol.ts';
import { onQuitCheck, send } from './socket.ts';
import { useStore } from './store.ts';
import { baseName } from './bits.tsx';

const count = (n: number, one: string) => (n ? `${n} ${one}${n === 1 ? '' : 's'}` : '');

function workLine(s: QuitWork['sessions'][number]) {
  return [s.turn ? 'reply in progress' : '', count(s.agents, 'agent'), count(s.codex, 'Codex agent'), count(s.procs, 'background command')].filter(Boolean).join(' · ');
}

// Mount on demand from the header menu; the server answers quit-check with what is running right now.
export default function QuitDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [work, setWork] = useState<QuitWork | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    onQuitCheck((m) => setWork(m.work));
    if (!send({ type: 'quit-check' })) setError('Not connected. Try again when the connection returns.');
    return () => {
      onQuitCheck(null);
      node.close();
    };
  }, []);
  const busy = !!work && (work.sessions.length > 0 || work.runs.length > 0);
  return <dialog ref={dialog} className="pal quit-dialog" aria-labelledby={title} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <form className="qd" onSubmit={(e) => {
      e.preventDefault();
      if (!send({ type: 'quit' })) return setError('Not connected. Try again when the connection returns.');
      // Set here too, so the page stops reconnecting even if the socket drops before the server's reply.
      useStore.setState({ quit: 'stopping' });
    }}>
      <h2 id={title}>Quit tarcsweb?</h2>
      <p className="set-hint">This shuts down tarcsweb on this computer, not only this window. Saved sessions and settings are kept for the next time you open it.</p>
      {!work && !error && <p className="qd-note" role="status">Checking what is running…</p>}
      {work && !busy && <p className="qd-note">Nothing is running right now.</p>}
      {busy && (
        <div className="qd-work">
          <p className="qd-note">This stops:</p>
          <ul>
            {work.sessions.map((s) => <li key={s.id}><b>{s.name}</b><small>{workLine(s)}</small></li>)}
            {work.runs.map((r) => <li key={`${r.folder}\0${r.label}`}><b>{r.label}</b><small>Project command · {baseName(r.folder)}</small></li>)}
          </ul>
        </div>
      )}
      {error && <p className="set-err" role="alert">{error}</p>}
      <div className="qd-acts">
        <button type="button" className="set-clear" onClick={onClose} autoFocus>Cancel</button>
        <button type="submit" className="set-btn qd-quit" disabled={!work}>Quit tarcsweb</button>
      </div>
    </form>
  </dialog>;
}
