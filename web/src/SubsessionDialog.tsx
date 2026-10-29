import { useEffect, useId, useRef, useState } from 'react';
import type { SessionSummary } from '../../server/protocol.ts';
import { openSubsession } from './actions.ts';
import { useStore } from './store.ts';

// Mount on demand from the sidebar; key by source.id so a new parent starts a fresh form.
export default function SubsessionDialog({ source, onClose }: { source: SessionSummary; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const sw = useId();
  const [folder, setFolder] = useState(source.cwd);
  const [worktree, setWorktree] = useState(true);
  const [instruction, setInstruction] = useState('');
  const [handoff, setHandoff] = useState('');
  const [error, setError] = useState('');
  const path = folder.trim();
  // The server always gives it its own worktree when an open session already uses the repository; the same folder is the case known here.
  const roster = useStore((s) => s.roster);
  const sharer = roster.find((r) => r.cwd === path && r.branch !== null)?.name;
  const child = source.group && source.group.mainId !== source.id;
  const ready = !child && !!path && !!instruction.trim() && !!handoff.trim();
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  return <dialog ref={dialog} className="pal sub-session-dialog" aria-labelledby={title} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <form className="ssd" onSubmit={(e) => {
      e.preventDefault();
      if (!ready) return;
      if (useStore.getState().pendingOpen) return setError('Another session is still opening. Try again in a moment.');
      if (!openSubsession({ type: 'group-open', sessionId: source.id, folder: path, worktree: !!sharer || worktree, instruction: instruction.trim(), handoff: handoff.trim() })) {
        return setError('Not connected. Try again when the connection returns.');
      }
      onClose();
    }}>
      <h2 id={title}>New sub-session</h2>
      <p className="set-hint">It starts with the task, what you carry over and the group's shared summary. The main session merges the results.</p>
      <label className="set-fl"><span>Folder</span><input className="set-in mono" value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={4096} required autoFocus spellCheck={false} /></label>
      <div className="set-swrow">
        <div className="set-l">
          <label htmlFor={sw}>Use a separate worktree</label>
          <small id={`${sw}-h`}>{sharer ? `Required while ${sharer} is open in this repository` : 'Used anyway if an open session already works in this repository'}</small>
        </div>
        <button
          id={sw} type="button" role="switch" className="set-sw" aria-checked={!!sharer || worktree} disabled={!!sharer} aria-describedby={`${sw}-h`}
          onClick={() => setWorktree(!worktree)}
        >
          <i></i>
        </button>
      </div>
      <label className="set-fl"><span>Task</span><textarea className="set-in" value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={16000} required placeholder="What should this sub-session finish?" /></label>
      <label className="set-fl"><span>What to carry over</span><textarea className="set-in" value={handoff} onChange={(e) => setHandoff(e.target.value)} maxLength={16000} required placeholder="Relevant decisions, constraints, files and next steps. No full conversation history." /></label>
      {child && <p className="set-err" role="alert">Sub-sessions cannot create sub-sessions.</p>}
      {error && <p className="set-err" role="alert">{error}</p>}
      <div className="ssd-acts">
        <button type="button" className="set-clear" onClick={onClose}>Cancel</button>
        <button type="submit" className="set-btn" disabled={!ready}>Open sub-session</button>
      </div>
    </form>
  </dialog>;
}
