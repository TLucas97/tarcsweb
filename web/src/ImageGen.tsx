import { useEffect, useState } from 'react';
import type { RichDetail } from '../../server/protocol.ts';
import { useStore, type RichItem } from './store.ts';
import { Pending } from './bits.tsx';
import { ToolImage } from './LocalImage.tsx';

type Detail = Extract<RichDetail, { kind: 'image' }>;
// The tool gives up after 6 minutes; a card still waiting past this belongs to a session that ended mid-call.
const STALE_MS = 7 * 60_000;

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const tilde = (path: string, home: string) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

// Codex sends nothing between start and end, so the elapsed time is counted here from the call's start; it stops at STALE_MS.
function useElapsed(from: number | undefined, live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !from || Date.now() - from > STALE_MS) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n - from > STALE_MS) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [live, from]);
  return from ? now - from : null;
}

// generate_image: a waiting card with a running clock, then the saved pictures with their paths.
export function ImageGen({ item }: { item: RichItem }) {
  const d = item.detail as Detail;
  const home = useStore((s) => s.home);
  const r = item.result;
  const elapsed = useElapsed(item.at, !r);
  const stale = !r && elapsed !== null && elapsed > STALE_MS;
  const images = r?.images ?? [];
  const many = d.count > 1;
  return (
    <div className="frame ig" data-id={item.id}>
      <div className="fh">
        <span className="tool mono">generate_image</span>
        <span className="n" title={d.prompt}>{d.prompt || 'Image'}</span>
        {r ? r.ms !== undefined && <span className="end ig-t">{clock(r.ms)}</span> : !stale && elapsed !== null && <span className="end ig-t">{clock(elapsed)}</span>}
      </div>
      {r?.error ? (
        <div className="vmsg bad">{r.error}</div>
      ) : r ? (
        <div className={`ig-grid${images.length > 1 ? ' many' : ''}`}>
          {images.map((img) => (
            <figure key={img.path}>
              <ToolImage src={img.src} alt={img.path.split('/').pop() || 'Image'} />
              <figcaption className="mono" title={img.path}>{tilde(img.path, home)}</figcaption>
            </figure>
          ))}
          {!images.length && <div className="vmsg">No image came back.</div>}
        </div>
      ) : stale ? (
        <div className="vmsg">This generation did not finish.</div>
      ) : (
        <div className="ig-wait">
          <div className={`ig-grid${many ? ' many' : ''}`}>
            {Array.from({ length: d.count }, (_, i) => <div key={i} className="ig-ph" />)}
          </div>
          <Pending text={`Generating ${many ? `${d.count} images` : 'the image'} with Codex…`} />
        </div>
      )}
    </div>
  );
}
