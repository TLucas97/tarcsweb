import type { ReactNode } from 'react';
import { z } from 'zod';
import { Card } from './card.tsx';
import { defineUi, text } from './define.ts';
import { loose } from './loose.ts';
import { pop, rise, type Stage } from './motion.ts';

type Tone = 'note' | 'tip' | 'warning' | 'risk';
const TONES: Record<string, Tone> = {
  note: 'note', info: 'note', neutral: 'note',
  tip: 'tip', hint: 'tip', success: 'tip', good: 'tip',
  warning: 'warning', warn: 'warning', caution: 'warning', important: 'warning',
  risk: 'risk', danger: 'risk', error: 'risk', critical: 'risk', bad: 'risk',
};
const tone = z.preprocess((v) => {
  const k = String(v).trim().toLowerCase();
  return Object.hasOwn(TONES, k) ? TONES[k] : 'note';
}, z.enum(['note', 'tip', 'warning', 'risk']));

const schema = loose(
  z
    .object({ tone, title: text.optional(), body: z.union([text, z.array(text)]).optional() })
    .refine((b) => b.title || b.body, { message: 'needs a title or a body' }),
  { tone: ['kind', 'variant', 'level'], body: ['text', 'message', 'content', 'detail', 'description'] },
);
type Data = z.output<typeof schema>;

const NAME: Record<Tone, string> = { note: 'Note', tip: 'Tip', warning: 'Warning', risk: 'Risk' };
const svg = (d: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const ICON: Record<Tone, ReactNode> = {
  note: svg(<><circle cx="8" cy="8" r="6.25" /><path d="M8 7.3v3.7M8 5h.01" /></>),
  tip: svg(<><path d="M6 12.5h4M6.6 14.5h2.8M5.6 10.4A4.3 4.3 0 1 1 10.4 10.4c-.5.4-.8.9-.8 1.4v.2H6.4v-.2c0-.5-.3-1-.8-1.4Z" /></>),
  warning: svg(<><path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.6 9.75a1 1 0 0 1-.87 1.5H2.4a1 1 0 0 1-.87-1.5Z" /><path d="M8 6.3v3M8 11.4h.01" /></>),
  risk: svg(<><path d="M5.4 1.75h5.2l3.65 3.65v5.2l-3.65 3.65H5.4L1.75 10.6V5.4Z" /><path d="M8 4.9v3.6M8 10.9h.01" /></>),
};

// Paragraphs split on blank lines; `code` spans keep their look, other Markdown marks are dropped.
const paras = (b: Data) => (Array.isArray(b.body) ? b.body : (b.body ?? '').split(/\n\s*\n/)).map((p) => p.trim()).filter(Boolean);
const inline = (s: string) =>
  s
    .replace(/\*\*|__/g, '')
    .split(/(`[^`]+`)/)
    .map((x, i) => (i % 2 ? <code key={i}>{x.slice(1, -1)}</code> : x));

// The mark lands first, then the heading and the body settle under it.
const enter: Stage = (root) => [
  ...pop(root.querySelectorAll('.ub-co-ic'), { duration: 280 }, 0.7),
  ...rise(root.querySelectorAll('.ub-co-c>*'), { delay: 60, stagger: 50, duration: 320 }, 4),
];

function Callout({ b }: { b: Data }) {
  const ps = paras(b);
  return (
    <Card label={b.title || NAME[b.tone]} head={false} stage={enter} className={`ub-co ${b.tone}`}>
      <div className="ub-co-in" role="note">
        <span className="ub-co-ic">{ICON[b.tone]}</span>
        <span className="ub-sr">{NAME[b.tone]}: </span>
        <div className="ub-co-c">
          {b.title && <p className="ub-co-t">{b.title}</p>}
          {ps.map((p, i) => <p key={i} className="ub-co-p">{inline(p)}</p>)}
        </div>
      </div>
    </Card>
  );
}

export const callout = defineUi({ schema, Component: Callout, label: 'Building note…' });
