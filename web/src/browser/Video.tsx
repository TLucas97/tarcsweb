import { useState } from 'react';
import type { BrowserVideo } from '../../../server/protocol.ts';
import { tilde } from '../bits.tsx';
import { useStore } from '../store.ts';

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const PlayIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M6 3.8v10.4a.6.6 0 0 0 .9.5l8-5.2a.6.6 0 0 0 0-1L6.9 3.3a.6.6 0 0 0-.9.5z" fill="currentColor" /></svg>
);

// A saved Browser panel recording: its first frame (lazy, like inline images) until clicked, then the video itself.
// fill: it takes its container's box (the panel's player) instead of sizing itself from the video.
export function RecVideo({ v, autoPlay = false, fill = false }: { v: BrowserVideo; autoPlay?: boolean; fill?: boolean }) {
  const home = useStore((s) => s.home);
  const [play, setPlay] = useState(autoPlay);
  const [gone, setGone] = useState(false);
  const [poster, setPoster] = useState(true);
  const path = tilde(v.path, home);
  if (gone) return <span className="limg miss" title={v.path}>{path} (deleted)</span>;
  return (
    <figure className={`rvid${fill ? ' fill' : ''}`}>
      <div className="rvid-box" style={fill ? undefined : { aspectRatio: `${v.w} / ${v.h}`, maxWidth: v.w }}>
        {play ? (
          <video src={v.src} poster={v.poster ?? undefined} controls autoPlay playsInline muted onError={() => setGone(true)} />
        ) : (
          <button type="button" className="rvid-play" aria-label="Play the recording" title="Play" onClick={() => setPlay(true)}>
            {v.poster && poster && <img src={v.poster} alt="" loading="lazy" decoding="async" onError={() => setPoster(false)} />}
            <span><PlayIcon /></span>
          </button>
        )}
      </div>
      <figcaption className="mono" title={v.path}>{path} · {clock(v.ms)}</figcaption>
    </figure>
  );
}
