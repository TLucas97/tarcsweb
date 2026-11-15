import { useEffect, useId, useRef } from 'react';
import { useStore, type ConfirmAsk } from './store.ts';

const close = () => useStore.setState({ confirm: null });

// A yes/no question in the Quit dialog's frame; App mounts it while the store holds one.
export default function ConfirmDialog({ ask }: { ask: ConfirmAsk }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return <dialog ref={dialog} className="pal quit-dialog" aria-labelledby={title} onCancel={(e) => { e.preventDefault(); close(); }}>
    <form className="qd" onSubmit={(e) => {
      e.preventDefault();
      close();
      ask.run();
    }}>
      <h2 id={title}>{ask.title}</h2>
      <p className="set-hint">{ask.body}</p>
      <div className="qd-acts">
        <button type="button" className="set-clear" onClick={close} autoFocus>Cancel</button>
        <button type="submit" className={`set-btn${ask.danger ? ' danger' : ''}`}>{ask.action}</button>
      </div>
    </form>
  </dialog>;
}
