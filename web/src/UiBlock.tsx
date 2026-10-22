import { lazy, Suspense } from 'react';
import { Pending } from './bits.tsx';

export const loadUiDraw = () => import('./UiDraw.tsx');
const UiDraw = lazy(loadUiDraw);

// Block labels by type, filled in when the UiDraw chunk loads.
let labels: Record<string, string> = {};
export const setUiLabels = (l: Record<string, string>) => void (labels = l);

function Wait({ src }: { src: string }) {
  const t = /"type"\s*:\s*"(\w+)"/.exec(src)?.[1];
  return (
    <div className="frame ub-wait" aria-busy="true">
      <div className="vmsg"><Pending text={(t && Object.hasOwn(labels, t) && labels[t]) || 'Building visual…'} /></div>
    </div>
  );
}

// A ```ui fence from the model: a JSON spec drawn by the component registered for its type.
export function UiBlock({ src, done, live = false }: { src: string; done: boolean; live?: boolean }) {
  if (!done) return <Wait src={src} />;
  return (
    <Suspense fallback={<Wait src={src} />}>
      <UiDraw src={src} live={live} />
    </Suspense>
  );
}
