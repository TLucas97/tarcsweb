import { useState } from 'react';
import type { BrowserRecording } from '../../../server/protocol.ts';
import { TrashIcon, XIcon, useEscape } from '../bits.tsx';
import { clock } from './Video.tsx';

const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const size = (b: number | undefined) => (!b ? '' : b < 1 << 20 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / (1 << 20)).toFixed(b < 100 << 20 ? 1 : 0)} MB`);

export const FilmIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <rect x="1.8" y="2.6" width="10.4" height="8.8" rx="1.6" />
    <path d="M4.4 2.6v8.8M9.6 2.6v8.8M1.8 5.5h2.6M1.8 8.5h2.6M9.6 5.5h2.6M9.6 8.5h2.6" />
  </svg>
);

type Props = {
  list: BrowserRecording[] | null;
  // Paths sent for deletion whose removal the server has not confirmed yet.
  deleting: ReadonlySet<string>;
  clearing: boolean;
  onPlay: (r: BrowserRecording) => void;
  onDelete: (r: BrowserRecording) => void;
  onClear: () => void;
  onClose: () => void;
};

// The panel's saved recordings over the stage, newest first. Deletes wait for the server's new list instead of
// vanishing at once, since they cannot be undone.
export function Library({ list, deleting, clearing, onPlay, onDelete, onClear, onClose }: Props) {
  const [confirm, setConfirm] = useState(false);
  const n = list?.length ?? 0;
  const asking = confirm && n > 0 && !clearing;
  useEscape(asking, () => setConfirm(false));

  return (
    <div className="brw-lib" role="dialog" aria-label="Recordings">
      <div className="brw-play-bar">
        <b>Recordings</b>
        {asking ? (
          <span className="brw-lib-ask" role="group" aria-label="Confirm delete all">
            <span>Delete {n} recording{n === 1 ? '' : 's'}?</span>
            <button
              type="button" className="brw-lib-btn danger"
              onClick={() => {
                setConfirm(false);
                onClear();
              }}
            >
              Delete
            </button>
            {/* Focus lands on the safe choice, so a stray Enter cancels. */}
            <button type="button" className="brw-lib-btn" autoFocus onClick={() => setConfirm(false)}>Cancel</button>
          </span>
        ) : n > 0 && (
          <button type="button" className="brw-lib-btn" disabled={clearing} onClick={() => setConfirm(true)}>{clearing ? 'Deleting…' : 'Delete all'}</button>
        )}
        <button type="button" className="brw-x" aria-label="Close recordings" title="Close (esc)" onClick={onClose}><XIcon /></button>
      </div>
      {!list ? (
        <p className="brw-lib-empty">Loading…</p>
      ) : !n ? (
        <p className="brw-lib-empty">No recordings yet</p>
      ) : (
        <ul className="brw-lib-list">
          {list.map((r) => {
            const title = r.title || 'Recording';
            const gone = clearing || deleting.has(r.path);
            return (
              <li key={r.path} className={gone ? 'gone' : undefined} aria-busy={gone}>
                <button type="button" className="brw-lib-row" title={r.path} disabled={gone} onClick={() => onPlay(r)}>
                  <span className="brw-lib-thumb">
                    {r.poster && <img src={r.poster} alt="" loading="lazy" decoding="async" />}
                    {r.ms > 0 && <i>{clock(r.ms)}</i>}
                  </span>
                  <span className="brw-lib-text">
                    <b>{title}</b>
                    <small>{[when.format(r.at), size(r.bytes)].filter(Boolean).join(' · ')}</small>
                  </span>
                </button>
                <button type="button" className="brw-x" aria-label={`Delete ${title}`} title="Delete from disk" disabled={gone} onClick={() => onDelete(r)}><TrashIcon /></button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
