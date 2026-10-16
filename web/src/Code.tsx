import { useEffect, useRef, useState } from 'react';
import { cached, highlight, keyOf, langOf, type Token } from './highlight.ts';
import { FxBtn } from './Focus.tsx';
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
export function CodeFrame({ code, lang, done }: { code: string; lang: string; done: boolean }) {
  const l = done ? langOf(lang) : null;
  const [hl, setHl] = useState<{ key: string; lines: Token[][] } | null>(null);
  const key = l ? keyOf(code, l) : '';
  const ready = l ? (hl?.key === key ? hl.lines : cached(code, l)) : null;
  const frame = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (!l || ready || near) return;
    return watchNear(frame.current!, () => setNear(true));
  }, [l, ready, near]);

  useEffect(() => {
    if (!l || ready || !near) return;
    let on = true;
    highlight(code, l).then((lines) => on && lines && setHl({ key, lines }), () => {});
    return () => {
      on = false;
    };
  }, [key, l, code, ready, near]);

  const lines: Token[][] = ready ?? code.split('\n').map((content) => [{ content }]);
  return (
    <div className="frame cframe" ref={frame}>
      <div className="fh">
        <span className="n mono">{lang || 'text'}</span>
        <CopyBtn code={code} />
        <FxBtn label={lang ? `${lang} code` : 'Code'} />
      </div>
      <div className="code mono">
        {lines.map((ln, i) => (
          <div key={i}>{ln.length && ln.some((t) => t.content) ? ln.map((t, j) => <span key={j} style={t.color ? { color: t.color } : undefined}>{t.content}</span>) : ' '}</div>
        ))}
      </div>
    </div>
  );
}
