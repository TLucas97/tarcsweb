import { useEffect, useRef, useState } from 'react';
import { cached, highlight, keyOf, langOf, type Token } from './highlight.ts';
import { FxBtn } from './Focus.tsx';
import { fenced, SendTextBtn } from './SendToChat.tsx';
import { watchNear } from './near.ts';

function CopyBtn({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <button
      type="button" className="btnx end" title="Copy the code"
      onClick={() => {
        void navigator.clipboard?.writeText(code).then(() => {
          setDone(true);
          clearTimeout(t.current);
          t.current = window.setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

// A fenced code block as a frame; it is colored only once its closing fence arrived, so streaming stays plain.
// Off screen it stays plain too, so opening a long session does not tokenize every block.
// Prose blocks wrap instead of scrolling sideways; real code keeps its lines.
const PROSE = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'markdown', 'md']);

// A finished block longer than FOLD_OVER lines shows its first FOLD_SHOW. The rest stays in the DOM, hidden, so Find still sees it.
const FOLD_OVER = 40;
const FOLD_SHOW = 24;
const unfolders = new WeakMap<Element, () => void>();

// Opens the folded code frame holding `node`; true when one opened.
export function unfoldCode(node: Node) {
  const el = node instanceof Element ? node : node.parentElement;
  const frame = el?.closest('.cframe');
  const open = frame && el?.closest('.cfold-x') ? unfolders.get(frame) : undefined;
  open?.();
  return !!open;
}

// as: the fence language Send to chat uses, when it differs from the one shown (a ui block that failed to draw).
export function CodeFrame({ code, lang, done, as }: { code: string; lang: string; done: boolean; as?: string }) {
  const l = done ? langOf(lang) : null;
  const [hl, setHl] = useState<{ key: string; lines: Token[][] } | null>(null);
  const key = l ? keyOf(code, l) : '';
  const ready = l ? (hl?.key === key ? hl.lines : cached(code, l)) : null;
  const frame = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!l || ready || near) return;
    return watchNear(frame.current!, () => setNear(true));
  }, [l, ready, near]);

  useEffect(() => {
    if (!l || ready || !near) return;
    const stop = new AbortController();
    highlight(code, l, stop.signal).then((lines) => !stop.signal.aborted && lines && setHl({ key, lines }), () => {});
    return () => stop.abort();
  }, [key, l, code, ready, near]);

  const lines: Token[][] = ready ?? code.split('\n').map((content) => [{ content }]);
  // A block still streaming stays whole, so its newest lines are in view as they arrive.
  const folded = done && !all && lines.length > FOLD_OVER;
  useEffect(() => {
    const el = frame.current;
    if (!folded || !el) return;
    unfolders.set(el, () => setAll(true));
    return () => void unfolders.delete(el);
  }, [folded]);
  return (
    <div className="frame cframe" ref={frame}>
      <div className="fh">
        <span className="n mono">{lang || 'text'}</span>
        {done && <SendTextBtn text={() => fenced(code, as ?? lang)} what="the code" />}
        <CopyBtn code={code} />
        <FxBtn label={lang ? `${lang} code` : 'Code'} />
      </div>
      <div className={PROSE.has(lang.toLowerCase()) ? 'code mono wrap' : 'code mono'}>
        {lines.map((ln, i) => (
          <div key={i} hidden={folded && i >= FOLD_SHOW} className={folded && i >= FOLD_SHOW ? 'cfold-x' : undefined}>
            {ln.length && ln.some((t) => t.content) ? ln.map((t, j) => <span key={j} style={t.color ? { color: t.color } : undefined}>{t.content}</span>) : ' '}
          </div>
        ))}
      </div>
      {folded && <button type="button" className="cfold" onClick={() => setAll(true)}>Show all {lines.length} lines</button>}
    </div>
  );
}
