import { useEffect, useRef, useState } from 'react';
import { useStore } from './store.ts';
import { PowerIcon } from './bits.tsx';

// Imported statically: once the server is gone, a lazy chunk could not load. A modal so it covers any open dialog.
export function Stopped() {
  const quit = useStore((s) => s.quit);
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState(false);
  useEffect(() => {
    if (quit) dialog.current?.showModal();
  }, [quit]);
  if (!quit) return null;
  return (
    <dialog ref={dialog} className="stopped" aria-labelledby="stopped-t" onCancel={(e) => e.preventDefault()}>
      <PowerIcon />
      {quit === 'stopping' ? (
        <>
          <h1 id="stopped-t">Quitting tarcsweb…</h1>
          <p role="status">Stopping sessions and project commands.</p>
        </>
      ) : (
        <>
          <h1 id="stopped-t">tarcsweb is closed</h1>
          <p>To use it again, open tarcsweb from your app launcher.</p>
          {tab ? <p className="stopped-tab">You can close this tab now.</p> : (
            <button
              type="button" className="set-btn" onClick={() => {
                window.close();
                // A normal browser tab ignores close(); the --app window does not.
                setTimeout(() => setTab(true), 300);
              }}
            >
              Close window
            </button>
          )}
        </>
      )}
    </dialog>
  );
}
