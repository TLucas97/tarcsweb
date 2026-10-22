import { useEffect, useState } from 'react';
import { cached, highlight, langOf, type Token } from '../highlight.ts';
import { schema, type Data } from './beforeafter.schema.ts';
import { Card } from './card.tsx';
import { defineUi } from './define.ts';
import { fade, rise, type Stage } from './motion.ts';

const trim = (s: string) => s.replace(/^\n+|\s+$/g, '');

// Lines only one side has, by longest common subsequence; nothing is marked when the sides share no line.
function changes(a: string[], b: string[]) {
  const none = [new Set<number>(), new Set<number>()] as const;
  const n = a.length;
  const m = b.length;
  if (n * m > 40000) return none;
  const k = (s: string) => s.trim();
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = k(a[i]) === k(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  if (!dp[0][0] || dp[0][0] === Math.max(n, m)) return none;
  const del = new Set<number>();
  const add = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && k(a[i]) === k(b[j])) (i++, j++);
    else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) del.add(i++);
    else add.add(j++);
  }
  for (const [set, src] of [[del, a], [add, b]] as const) for (const x of set) if (!k(src[x])) set.delete(x);
  return [del, add] as const;
}

function useTokens(code: string, lang: string | null) {
  const [hl, setHl] = useState<{ key: string; lines: Token[][] } | null>(null);
  const key = lang ? `${lang}\u0000${code}` : '';
  const ready = lang ? (hl?.key === key ? hl.lines : cached(code, lang)) : null;
  useEffect(() => {
    if (!lang || ready) return;
    let on = true;
    highlight(code, lang).then((lines) => on && lines && setHl({ key, lines }), () => {});
    return () => {
      on = false;
    };
  }, [key, lang, code, ready]);
  return ready;
}

function Pane({ kind, label, code, lang, marks }: { kind: 'before' | 'after'; label: string; code: string; lang?: string; marks: Set<number> }) {
  const l = lang ? langOf(lang) : null;
  const tokens = useTokens(code, l);
  const lines: Token[][] = tokens ?? code.split('\n').map((content) => [{ content }]);
  return (
    <figure className={`ub-ba-p ${kind}`} aria-label={label}>
      <figcaption className="ub-ba-cap">
        <span className="ub-ba-lb">{label}</span>
        {lang && <span className="ub-ba-lang mono">{lang}</span>}
      </figcaption>
      <div className={lang ? 'code mono ub-ba-code' : 'ub-ba-txt'}>
        {lines.map((ln, i) => (
          <div key={i} className={marks.has(i) ? 'ub-ba-l ub-ba-ch' : 'ub-ba-l'}>
            {marks.has(i) && <i className="ub-ba-hl" aria-hidden="true" />}
            {marks.has(i) && <span className="ub-sr">{kind === 'before' ? 'Removed: ' : 'Added: '}</span>}
            {ln.some((t) => t.content) ? ln.map((t, j) => <span key={j} style={t.color ? { color: t.color } : undefined}>{t.content}</span>) : ' '}
          </div>
        ))}
      </div>
    </figure>
  );
}

const AFTER = 300; // the after side starts once the before side has mostly landed

// Before lands first, its removed lines tint; then after lands and its added lines light up.
const enter: Stage = (root) => {
  const out: Animation[] = [];
  root.querySelectorAll('.ub-ba-p').forEach((pane, p) => {
    const lines = pane.querySelectorAll('.ub-ba-l');
    const step = Math.min(22, 260 / Math.max(1, lines.length));
    const t0 = p * AFTER;
    const at = (el: Element) => t0 + 40 + [...lines].indexOf(el.closest('.ub-ba-l')!) * step;
    out.push(
      ...fade(pane.querySelectorAll('.ub-ba-cap'), { delay: t0, duration: 240 }),
      ...rise(lines, { delay: at, duration: 300 }, 3),
      ...fade(pane.querySelectorAll('.ub-ba-hl'), { delay: (el) => at(el) + 160, duration: 220 }),
    );
  });
  out.push(...fade(root.querySelectorAll('.ub-ba-note'), { delay: AFTER + 300, duration: 240 }));
  return out;
};

function BeforeAfter({ b }: { b: Data }) {
  const before = trim(b.before.code);
  const after = trim(b.after.code);
  const [del, add] = changes(before.split('\n'), after.split('\n'));
  return (
    <Card title={b.title} label="Before and after" stage={enter} className="ub-ba">
      <div className="ub-ba-grid">
        <Pane kind="before" label={b.before.label || 'Before'} code={before} lang={b.before.lang ?? b.lang} marks={del} />
        <Pane kind="after" label={b.after.label || 'After'} code={after} lang={b.after.lang ?? b.lang} marks={add} />
      </div>
      {b.note && <p className="ub-ba-note">{b.note}</p>}
    </Card>
  );
}

export const beforeafter = defineUi({ schema, Component: BeforeAfter, label: 'Building before and after…' });
