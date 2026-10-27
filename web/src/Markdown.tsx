import { createContext, Fragment, memo, useContext, useEffect, useMemo, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeFrame } from './Code.tsx';
import { FxBtn, ReadBtn } from './Focus.tsx';
import { openImage } from './openImage.ts';
import { InlineRead } from './InlineRead.tsx';
import { LocalImage, localImagePath } from './LocalImage.tsx';
import { fencedTable, TableFrame } from './TableFrame.tsx';
import { SendImageBtn, SendTextBtn } from './SendToChat.tsx';
import { UiBlock } from './UiBlock.tsx';
import { bareImages, blocksOf, liveBlocks } from './mdBlocks.ts';
import { composeBlock, remarkStretch, shownReply } from './stretch/compose.ts';
import { toggleStretch } from './stretch/motion.ts';
import { useOpen } from './stretch/store.ts';
import { remarkMentions } from './mention/token.tsx';

type MdNode = { type: string; value?: string; children?: MdNode[] };

// Text the owner typed or pasted keeps every newline as a line break, the way it was written.
function remarkBreaks() {
  const walk = (n: MdNode) => {
    if (!n.children) return;
    n.children = n.children.flatMap((c): MdNode[] => {
      if (c.type !== 'text' || !c.value?.includes('\n')) return walk(c), [c];
      return c.value.split('\n').flatMap((value, i) => (i ? [{ type: 'break' }, { type: 'text', value }] : [{ type: 'text', value }]));
    });
  };
  return walk;
}

// The composer's "• " bullets are Markdown "- " items once sent.
export const typedMarkdown = (text: string) => text.replace(/^(\s*)• /gm, '$1- ');

const plugins = [remarkGfm];
const typedPlugins = [remarkGfm, remarkBreaks, remarkMentions];
const stretchPlugins = [remarkGfm, remarkStretch];

// Markdown URLs arrive percent-encoded.
const decodeLink = (u: string) => {
  try {
    return u.startsWith('file://') ? u : decodeURI(u);
  } catch {
    return u;
  }
};
const textOfChildren = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(textOfChildren).join('') : '');

type HNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const textOf = (n: HNode): string => (n.type === 'text' ? n.value ?? '' : (n.children ?? []).map(textOf).join(''));

// A fenced block counts as finished once its own closing fence is in the source.
function closed(src: string) {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(src);
  if (!open) return true;
  const last = src.trimEnd().split('\n');
  return last.length > 1 && new RegExp(`^ {0,3}${open[1][0] === '`' ? '`' : '~'}{${open[1].length},}\\s*$`).test(last[last.length - 1]);
}

// Local images are signed by the server, so file:// links must reach the components untouched.
const urlTransform = (u: string) => (/^file:\/\//i.test(u) ? u : defaultUrlTransform(u));

// Per-block stretch data: the message, the block index and each stretch's stored key by its index in the block.
type StretchInfo = { msg: string; block: number; keys: string[] };
const StretchCtx = createContext<StretchInfo | null>(null);
const STRETCH_HREF = /^#st-([oc])-(\d+)$/;

// A closed stretch is a link-like button over its short form; « closes an open one.
function StretchLink({ href, children }: { href: string; children: ReactNode }) {
  const info = useContext(StretchCtx);
  const [, act, i] = STRETCH_HREF.exec(href)!;
  const n = Number(i);
  const key = info?.keys[n];
  if (!info || key === undefined) return <a href={href}>{children}</a>;
  const id = `${info.block}.${n}`;
  const open = act === 'o';
  const onClick = (e: MouseEvent<HTMLElement>) => toggleStretch(e.currentTarget, info.msg, key, id, open, e.detail === 0);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Space here must not reach the guided-reading play key.
    e.preventDefault();
    e.stopPropagation();
    toggleStretch(e.currentTarget, info.msg, key, id, true, true);
  };
  // A span, not a button: a button cannot wrap across lines, and a short form can be a whole sentence.
  return open ? (
    <span role="button" tabIndex={0} className="st-link" data-st-o={id} aria-expanded="false" onClick={onClick} onKeyDown={onKeyDown}>{children}</span>
  ) : (
    <button type="button" className="st-x" data-st-c={id} aria-expanded="true" aria-label="Show less" title="Show less" onClick={onClick}>«</button>
  );
}

const base: Components = {
  a: ({ node: _, ...p }) => {
    if (typeof p.href === 'string' && STRETCH_HREF.test(p.href)) return <StretchLink href={p.href}>{p.children}</StretchLink>;
    const img = typeof p.href === 'string' ? localImagePath(decodeLink(p.href)) : null;
    return img ? <LocalImage path={img} alt={textOfChildren(p.children)} /> : <a {...p} target="_blank" rel="noreferrer" />;
  },
  img: ({ node: _, src, alt, ...p }) => {
    const img = typeof src === 'string' ? localImagePath(decodeLink(src)) : null;
    if (img) return <LocalImage path={img} alt={alt} />;
    return (
      <span className="limg stc-host">
        <img src={src} alt={alt} loading="lazy" decoding="async" {...p} onClick={(e) => openImage(e)} />
        {typeof src === 'string' && src && <SendImageBtn src={src} name={alt || 'Image'} className="stc-float" />}
      </span>
    );
  },
  code: ({ node: _, className, children, ...p }) => {
    const img = !className && typeof children === 'string' ? localImagePath(children) : null;
    return (
      <>
        <code className={className ? `${className} mono` : 'mono'} {...p}>{children}</code>
        {img && <LocalImage path={img} />}
      </>
    );
  },
  table: GfmTable,
};

// Per-instance data for the module-level renderers: the block's own source and whether the message still streams.
const BlockSrc = createContext('');
const Live = createContext(false);

// Sends the table's own Markdown source, sliced from the block like a fence.
function GfmTable({ node, ...p }: ComponentProps<'table'> & ExtraProps) {
  const text = useContext(BlockSrc);
  const pos = (node as HNode | undefined)?.position;
  const src = () => (pos ? text.slice(pos.start.offset ?? 0, pos.end.offset ?? text.length).trim() : '');
  return (
    <div className="frame">
      <div className="ub-acts">{pos && <SendTextBtn text={src} what="the table" />}<FxBtn label="Table" /></div>
      <table className="tbl" {...p} />
    </div>
  );
}
const TABLE_FENCE = /^(mcp__app__)?show_table$/;

function Pre({ node }: ExtraProps) {
  const text = useContext(BlockSrc);
  const live = useContext(Live);
  const code = (node as HNode | undefined)?.children?.find((c) => c.tagName === 'code');
  const cls = code?.properties?.className;
  const lang = (Array.isArray(cls) ? cls.map(String).find((c) => c.startsWith('language-'))?.slice(9) : '') ?? '';
  const pos = (node as HNode | undefined)?.position;
  const src = pos ? text.slice(pos.start.offset ?? 0, pos.end.offset ?? text.length) : '';
  const body = code ? textOf(code).replace(/\n$/, '') : '';
  // Only the last block can hold an open fence: blocks split outside fences.
  const done = !live || closed(src);
  if (lang === 'ui') return <UiBlock src={body} done={done} live={live} />;
  // The model sometimes writes show_table's args as a fence named after the tool (#11).
  const table = done && TABLE_FENCE.test(lang) ? fencedTable(body) : null;
  return table ? <TableFrame t={table} /> : <CodeFrame code={body} lang={lang} done={done} />;
}

const components: Components = { ...base, pre: Pre };

// Parsed blocks of finished text by plugin set and source, so a remount (window shift, session switch) skips the parse.
// The elements hold no per-instance data: renderers read it from context.
type Kind = 'gfm' | 'typed' | 'stretch';
const PLUGINS = { gfm: plugins, typed: typedPlugins, stretch: stretchPlugins };
const parsed = new Map<string, ReactNode>();
const PARSED_MAX = 1500;
const PARSED_CHARS = 600_000;
let parsedChars = 0;

function parse(kind: Kind, text: string) {
  const key = `${kind}:${text}`;
  const hit = parsed.get(key);
  if (hit !== undefined) {
    parsed.delete(key);
    parsed.set(key, hit);
    return hit;
  }
  return ReactMarkdown({ remarkPlugins: PLUGINS[kind], components, urlTransform, children: text });
}

function remember(kind: Kind, text: string, el: ReactNode) {
  const key = `${kind}:${text}`;
  if (parsed.has(key) || text.length > PARSED_CHARS / 8) return;
  parsed.set(key, el);
  parsedChars += text.length;
  for (const [k] of parsed) {
    if (parsed.size <= PARSED_MAX && parsedChars <= PARSED_CHARS) break;
    parsed.delete(k);
    parsedChars -= k.length - k.indexOf(':') - 1;
  }
}

// One parsed block; while a reply streams only the growing last block re-parses. done: its text no longer changes.
const Block = memo(function Block({ text, typed, stretch, done }: { text: string; typed?: boolean; stretch?: boolean; done?: boolean }) {
  const kind: Kind = typed ? 'typed' : stretch ? 'stretch' : 'gfm';
  const el = useMemo(() => parse(kind, text), [kind, text]);
  // Kept from an effect, so a block finishing (done flips) reuses the parse it already has.
  useEffect(() => {
    if (done !== false) remember(kind, text, el);
  }, [done, kind, text, el]);
  return <BlockSrc.Provider value={text}>{el}</BlockSrc.Provider>;
});

// A block of an agent reply: its stretches drawn as the reader left them. Only blocks whose drawn text changed re-parse.
const StretchBlock = memo(function StretchBlock({ text, index, msg, open, live, done }: { text: string; index: number; msg: string; open: readonly string[]; live: boolean; done: boolean }) {
  if (!text.includes('{{')) return <Block text={text} done={done} />;
  const { md, keys } = composeBlock(text, index, open, live);
  const info: StretchInfo = { msg, block: index, keys };
  return <StretchCtx.Provider value={info}><Block text={md} stretch done={done} /></StretchCtx.Provider>;
});

// typed: the owner's own text, where a single newline is a line break. msg: an agent reply's id, whose stretches it draws.
export function Markdown({ text: raw, live = false, id, reader, typed, msg }: { text: string; live?: boolean; id?: string; reader?: boolean; typed?: boolean; msg?: string }) {
  const open = useOpen(msg);
  const key = msg ?? id;
  const blocks = live && key ? liveBlocks(key, raw, !!msg) : blocksOf(bareImages(raw), !!msg);
  // Guided reading restarts when what the reader sees changes.
  const shown = msg && !live && open.length ? shownReply(raw, open) : raw;
  return (
    <div className="say">
      {!reader && id && <><InlineRead id={id} text={shown} live={live} /><ReadBtn source={{ itemId: id }} /></>}
      <Live.Provider value={live}>
        {/* The newline keeps the text between blocks the same as one parse (Find, reading). */}
        {blocks.map((b, i) => (
          <Fragment key={i}>
            {i > 0 && '\n'}
            {msg ? <StretchBlock text={b} index={i} msg={msg} open={open} live={live} done={!live || i < blocks.length - 1} /> : <Block text={b} typed={typed} done={!live || i < blocks.length - 1} />}
          </Fragment>
        ))}
      </Live.Provider>
    </div>
  );
}
