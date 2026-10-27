import type { ReactNode } from 'react';

// "@path" or "@\"path with spaces\"", the CLI's own mention syntax, at the start or after whitespace.
const MENTION = /(^|\s)(@(?:"[^"\n]+"|[^\s"]+))/g;
const TRAIL = /[.,;:!?)\]]+$/;

// A mention as written: quoted when the path has a space or a quote, so the agent reads it whole.
export const mentionOf = (path: string) => (/[\s"]/.test(path) ? `@"${path.replace(/"/g, '')}"` : `@${path}`);

// Spans that read as paths (a slash, a dot or quotes), without trailing punctuation; "@name" alone stays plain text.
export function mentionSpans(text: string): [number, number][] {
  if (!text.includes('@')) return [];
  const out: [number, number][] = [];
  for (const m of text.matchAll(MENTION)) {
    let tok = m[2];
    const quoted = tok[1] === '"';
    if (!quoted) tok = tok.replace(TRAIL, '');
    if (tok.length < 2 || (!quoted && !/[./~]/.test(tok.slice(1)))) continue;
    const start = m.index + m[1].length;
    out.push([start, start + tok.length]);
  }
  return out;
}

// Sent bubbles without links: text with mention spans wrapped.
export function withMentions(text: string): ReactNode {
  const spans = mentionSpans(text);
  if (!spans.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of spans) {
    if (s > at) out.push(text.slice(at, s));
    out.push(<span key={s} className="mn">{text.slice(s, e)}</span>);
    at = e;
  }
  out.push(text.slice(at));
  return out;
}

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> };

// Remark plugin for typed text: mentions become spans; code and links keep their text as is.
export function remarkMentions() {
  const walk = (n: MdNode) => {
    if (!n.children || n.type === 'link' || n.type === 'linkReference') return;
    n.children = n.children.flatMap((c): MdNode[] => {
      if (c.type !== 'text' || !c.value) return walk(c), [c];
      const v = c.value;
      const spans = mentionSpans(v);
      if (!spans.length) return [c];
      const out: MdNode[] = [];
      let at = 0;
      for (const [s, e] of spans) {
        if (s > at) out.push({ type: 'text', value: v.slice(at, s) });
        const value = v.slice(s, e);
        out.push({ type: 'mention', data: { hName: 'span', hProperties: { className: ['mn'] }, hChildren: [{ type: 'text', value }] } });
        at = e;
      }
      if (at < v.length) out.push({ type: 'text', value: v.slice(at) });
      return out;
    });
  };
  return walk;
}
