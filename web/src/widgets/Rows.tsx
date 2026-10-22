import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RichDetail } from '../../../server/protocol.ts';
import { blocksOf } from '../mdBlocks.ts';
import { shownReply } from '../stretch/compose.ts';
import { openSession, send } from '../socket.ts';
import type { Item } from '../store.ts';
import { useWidgets } from './state.ts';

// A widget draws a light version of each row: text, one-line tool steps, and asks it can answer in one click.
const USER_MAX = 1200;

type HNode = { tagName?: string; properties?: { className?: unknown }; children?: HNode[] };
const langOf = (node: unknown) => {
  const code = (node as HNode | undefined)?.children?.find((c) => c.tagName === 'code');
  const cls = code?.properties?.className;
  return Array.isArray(cls) ? (cls.map(String).find((c) => c.startsWith('language-'))?.slice(9) ?? '') : '';
};

function Pre({ node, children }: ExtraProps & { children?: ReactNode }) {
  if (langOf(node) === 'ui') return <span className="wg-chip">Visual · open the session to see it</span>;
  return <pre className="wg-code mono">{children}</pre>;
}

const components: Components = {
  pre: Pre,
  a: ({ node: _, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
  img: ({ alt }) => <span className="wg-chip">{alt || 'Image'}</span>,
  table: ({ node: _, ...p }) => <div className="wg-tbl"><table {...p} /></div>,
};
const plugins = [remarkGfm];

const Block = memo(function Block({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>;
});

// While a reply streams, a stretch still open would show its raw braces; it waits until it closes.
function closedPart(t: string) {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] === '{' && t[i + 1] === '{') (depth++ === 0 && (open = i)), i++;
    else if (t[i] === '}' && t[i + 1] === '}' && depth > 0) depth--, i++;
  }
  return depth > 0 ? t.slice(0, open) : t;
}

// Short forms only: the full session is one click away.
const AgentText = memo(function AgentText({ text, live }: { text: string; live: boolean }) {
  const shown = shownReply(live ? closedPart(text) : text, []);
  return <div className="wg-say">{blocksOf(shown).map((b, i) => <Block key={i} text={b} />)}</div>;
});

function richLabel(d: RichDetail): [string, string] {
  switch (d.kind) {
    case 'visual': return ['Visual', d.title];
    case 'chart': return ['Chart', d.chart.title];
    case 'table': return ['Table', d.table.title];
    case 'plan': return ['Plan', d.plan.title];
    case 'choice': return ['Question', d.choice.question];
    case 'round': return ['Questions', d.round.title];
    case 'image': return ['Image', d.prompt];
    case 'replay': return ['Replay', d.title];
    case 'picture': return ['Image', d.caption || d.path.split('/').pop() || ''];
    case 'upload': return ['File request', d.prompt];
  }
}

const OpenBtn = ({ sid, label }: { sid: string; label: string }) => (
  <button type="button" className="wg-act" onClick={() => openSession(sid)}>{label}</button>
);

function Ask({ sid, it }: { sid: string; it: Extract<Item, { kind: 'permission' }> }) {
  const [sent, setSent] = useState(false);
  const answer = (allow: boolean) => {
    if (send({ type: 'permission-answer', sessionId: sid, id: it.id, allow })) setSent(true);
  };
  if (it.answer !== null || it.cancelled) {
    const word = it.cancelled ? 'Cancelled' : it.elsewhere ? 'Answered elsewhere' : it.answer ? 'Allowed' : 'Denied';
    return <p className="wg-line"><b>{word}</b> {it.summary}</p>;
  }
  // Questions and plans need the full card.
  const complex = !!it.questions || it.plan !== undefined;
  return (
    <div className="wg-ask">
      <p className="wg-ask-t">{it.title ?? (it.questions ? 'Claude has a question' : it.plan !== undefined ? 'Plan ready for review' : `Allow ${it.tool}?`)}</p>
      {!complex && it.summary && <p className="wg-ask-s mono">{it.summary}</p>}
      <div className="wg-ask-b">
        {complex ? (
          <OpenBtn sid={sid} label="Answer in session" />
        ) : (
          <>
            <button type="button" className="wg-act" disabled={sent} onClick={() => answer(false)}>Deny</button>
            <button type="button" className={`wg-act${it.defaultToNo ? '' : ' pri'}`} disabled={sent} onClick={() => answer(true)}>Allow</button>
          </>
        )}
      </div>
    </div>
  );
}

// A run of tool calls shrinks to its newest step and a count.
function Steps({ sid, tools }: { sid: string; tools: string[] }) {
  const last = useWidgets((s) => s.convs[sid]?.items[tools[tools.length - 1]]);
  if (last?.kind !== 'tool') return null;
  const running = !last.result;
  return (
    <p className={`wg-line wg-step${running ? ' run' : ''}${last.result?.error ? ' bad' : ''}`}>
      <span className="wg-verb">{last.verb}</span> <span className="wg-sum mono">{last.desc || last.summary}</span>
      {tools.length > 1 && <span className="wg-n">+{tools.length - 1}</span>}
    </p>
  );
}

export const Row = memo(function Row({ sid, id, live }: { sid: string; id: string; live: boolean }) {
  const it = useWidgets((s) => s.convs[sid]?.items[id]);
  if (!it) return null;
  switch (it.kind) {
    case 'user': {
      const text = it.text.length > USER_MAX ? `${it.text.slice(0, USER_MAX)}…` : it.text;
      const extra = (it.files?.length ?? 0) + (it.pastes?.length ?? 0);
      return (
        <div className={`wg-u${it.queued ? ' q' : ''}`}>
          <p>{text}{extra > 0 && <span className="wg-n"> +{extra} attached</span>}</p>
          {it.stopped && <small>Stopped</small>}
        </div>
      );
    }
    case 'agent':
      return <AgentText text={it.text} live={live} />;
    case 'group':
      return <Steps sid={sid} tools={it.tools} />;
    case 'tool':
      return <p className="wg-line wg-step"><span className="wg-verb">{it.verb}</span> <span className="wg-sum mono">{it.desc || it.summary}</span></p>;
    case 'rich': {
      if (it.replaced) return null;
      const [kind, title] = richLabel(it.detail);
      const asking = (it.detail.kind === 'choice' || it.detail.kind === 'round' || it.detail.kind === 'upload') && !it.partial && !it.result;
      return (
        <div className={`wg-rich${asking ? ' ask' : ''}`}>
          <span className="wg-chip">{kind}</span>
          <span className="wg-sum">{title}</span>
          {asking && <OpenBtn sid={sid} label="Answer in session" />}
        </div>
      );
    }
    case 'permission':
      return <Ask sid={sid} it={it} />;
    case 'error':
      return <p className="wg-line bad">{it.message}</p>;
    default:
      return null;
  }
});
