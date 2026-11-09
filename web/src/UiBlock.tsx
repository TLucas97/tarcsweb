import { createContext, lazy, Suspense } from 'react';
import { Pending } from './bits.tsx';
import { CodeFrame } from './Code.tsx';
import { ChunkGuard } from './Stale.tsx';

// Set only around a main-conversation reply, so a block that fails to draw there can tell the model.
export const UiReport = createContext<{ sessionId: string; itemId: string } | null>(null);

export const loadUiDraw = () => import('./UiDraw.tsx');
const UiDraw = lazy(loadUiDraw);

// Block labels by type, filled in when the UiDraw chunk loads.
let labels: Record<string, string> = {};
export const setUiLabels = (l: Record<string, string>) => void (labels = l);

// A block still inside `{"type":"…`: its type is unknown for a few tokens more.
const OPENING = /^\s*(?:\{\s*(?:"(?:t(?:y(?:p(?:e(?:"\s*(?::\s*(?:"\w*)?)?)?)?)?)?)?)?)?$/;

// A streaming topic's title so far, decoded; a \u escape cut off at the end waits for its next token.
function partialTitle(src: string) {
  const raw = /"title"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(src)?.[1] ?? '';
  const whole = raw.replace(/((?:^|[^\\])(?:\\\\)*)\\u[0-9a-fA-F]{0,3}$/, '$1');
  try {
    return JSON.parse(`"${whole}"`) as string;
  } catch {
    return whole;
  }
}

function Wait({ src }: { src: string }) {
  // Nothing until the type is known, so no block flashes a frame that is not its own.
  if (OPENING.test(src)) return null;
  const t = /"type"\s*:\s*"(\w+)"/.exec(src)?.[1];
  // A topic is a one-line heading: it streams in place as text, so no visual frame flashes before it.
  if (t === 'topic') return <h2 className="ub-topic" dir="auto" aria-busy="true">{partialTitle(src)}</h2>;
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
    <ChunkGuard fallback={<CodeFrame code={src} lang="json" done as="ui" />}>
      <Suspense fallback={<Wait src={src} />}>
        <UiDraw src={src} live={live} />
      </Suspense>
    </ChunkGuard>
  );
}
