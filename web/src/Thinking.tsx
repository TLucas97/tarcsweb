import { Suspense, lazy, useState } from 'react';
import { ChevSmall, LiveLed } from './Tools.tsx';
import { useAmbient, useLite } from './perf.ts';
import { useSetup } from './setup.ts';
import type { Item } from './store.ts';

const Clock = lazy(() => import('./ThinkingLive.tsx'));

function summaryText(text: string) {
  return text.split(/\n\s*\n/).map((part, i) => (
    <p key={i}>{part.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|^#{1,6} .+$)/m).map((span, j) => {
      if (span.startsWith('**') && span.endsWith('**')) return <strong key={j}>{span.slice(2, -2)}</strong>;
      if (span.startsWith('`') && span.endsWith('`')) return <code key={j}>{span.slice(1, -1)}</code>;
      if (/^#{1,6} /.test(span)) return <strong key={j}>{span.replace(/^#+ /, '')}</strong>;
      return span;
    })}</p>
  ));
}

export function ThinkingRow({ item }: { item: Extract<Item, { kind: 'thinking' }> }) {
  const show = useSetup((s) => s.settings?.showReasoning !== false);
  return show && <Thought item={item} />;
}

function Thought({ item }: { item: Extract<Item, { kind: 'thinking' }> }) {
  const { id, text, since, end, live } = item;
  const lite = useLite();
  const still = useAmbient();
  const [open, setOpen] = useState(false);
  const [peekShown, setPeekShown] = useState(false);
  const peek = live && !lite && !open && !!text;
  if (peek && !peekShown) setPeekShown(true);
  const preview = text.slice(0, 320).trimStart().split('\n', 1)[0]?.replace(/^#+\s+|[*`]/g, '');
  const seconds = since === undefined ? null : end === undefined ? 0 : Math.max(1, Math.round((end - since) / 1000));
  const liveLimit = 8192;
  return (
    <div className="think-row" data-id={id}>
      <details className={`acts think-details${live ? ' live' : ''}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <ChevSmall />
          <span className="think-label">{live ? 'Thinking' : 'Thought'}</span>
          {seconds !== null && (!live || !still) && (
            <span className="think-time mono">
              {live && since !== undefined ? <Suspense fallback="0s"><Clock since={since} /></Suspense> : `${seconds}s`}
            </span>
          )}
          <span className="think-preview">{preview}</span>
          {live && <LiveLed label="Thinking" />}
        </summary>
        {open && <div className="think-body" tabIndex={0} aria-label="Reasoning summary">
          {live ? (text.length > liveLimit ? `…${text.slice(-liveLimit)}` : text) : summaryText(text)}
        </div>}
      </details>
      {(peek || (peekShown && !live && !still && !open)) && (
        <div className={`think-peek${live ? '' : ' gone'}`} aria-hidden="true" onAnimationEnd={() => setPeekShown(false)}>
          <span>{text.slice(-1024).replace(/`([^`]+)`/g, '$1')}</span>
        </div>
      )}
    </div>
  );
}
