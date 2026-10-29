import { useEffect, useId, useRef, useState } from 'react';
import type { SessionSummary } from '../../server/protocol.ts';
import { send } from './socket.ts';

// Mount on demand from the sidebar; key by source.id so a new parent starts a fresh form.
export default function SubsessionDialog({ source, onClose }: { source: SessionSummary; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [folder, setFolder] = useState(source.cwd);
  const [worktree, setWorktree] = useState(true);
  const [instruction, setInstruction] = useState('');
  const [handoff, setHandoff] = useState('');
  const [error, setError] = useState('');
  const child = source.group && source.group.mainId !== source.id;
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  return <dialog ref={dialog} className="pal sub-session-dialog" aria-labelledby={title} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <form className="pal-transfer" onSubmit={(e) => {
      e.preventDefault();
      if (child || !folder.trim() || !instruction.trim() || !handoff.trim()) return;
      if (!send({ type: 'group-open', sessionId: source.id, folder: folder.trim(), worktree, instruction: instruction.trim(), handoff: handoff.trim() })) { setError('Not connected. Try again when the connection returns.'); return; }
      onClose();
    }}>
      <h2 id={title}>New sub-session</h2>
      <p>Keep the main session focused on the plan. Give this sub-session one task and a short handoff.</p>
      <label>Folder<input value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={4096} required autoFocus /></label>
      <label className="sub-session-choice"><input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />Use a separate worktree</label>
      <small>A separate worktree is always used when another open session shares this repository. The main session merges the results.</small>
      <label>Task<textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={16000} required placeholder="What should this sub-session finish?" /></label>
      <label>What to carry over<textarea value={handoff} onChange={(e) => setHandoff(e.target.value)} maxLength={16000} required placeholder="Relevant decisions, constraints, files and next steps. No full conversation history." /></label>
      <small>The shared group summary is included automatically.</small>
      {child && <p role="alert">Sub-sessions cannot create sub-sessions.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="sub-session-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={!!child || !folder.trim() || !instruction.trim() || !handoff.trim()}>Open sub-session</button></div>
    </form>
  </dialog>;
}
