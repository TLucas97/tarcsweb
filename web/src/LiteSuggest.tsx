import { useState, type KeyboardEvent } from 'react';
import type { PerfProfile } from '../../server/protocol.ts';
import { saveSettings } from './setup.ts';
import { hide, snooze } from './machine.ts';

// Suggests Lite mode; machine.ts decides when. Loaded lazily, so nobody pays for it until it shows.
export default function LiteSuggestCard({ reason }: { reason: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (perf: PerfProfile) => {
    setBusy(true);
    setError(null);
    const err = await saveSettings({ perf });
    setBusy(false);
    if (err) setError(err);
    else hide();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') snooze();
  };

  return (
    <div className="toasts" onKeyDown={onKey}>
      <section className="hub lsg" role="region" aria-label="Suggestion">
        <b className="lsg-t">Make tarcsweb lighter?</b>
        <p className="lsg-b">{reason} Lite mode turns off extras like the animated robot and live backgrounds. Your conversations and tools stay the same.</p>
        {error && <p className="lsg-e" role="alert">{error}</p>}
        <div className="lsg-a">
          <button type="button" className="hu-act allow" disabled={busy} onClick={() => choose('lite')}>Turn on Lite</button>
          <button type="button" className="hu-act" disabled={busy} onClick={snooze}>Not now</button>
          <button type="button" className="hu-act" disabled={busy} onClick={() => choose('standard')}>Don't ask again</button>
        </div>
      </section>
    </div>
  );
}
